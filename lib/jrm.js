/*
 * Copyright 2019 Joyent, Inc.
 * Copyright 2022 MNX Cloud, Inc.
 */

/*
 * A class to manage working with Triton repos.
 */

'use strict';

var assert = require('assert-plus');
var forkExecWait = require('forkexec').forkExecWait;
var format = require('util').format;
var fs = require('fs');
var jsprim = require('jsprim');
var minimatch = require('minimatch');
var path = require('path');
// We are cheating here. restify-clients should export its 'bunyan'.
var restifyBunyanSerializers = require('restify-clients/lib/helpers/bunyan')
    .serializers;
var vasync = require('vasync');
var VError = require('verror');

// ---- constants

var DEFAULT_CONCURRENCY = 10;

// ---- internal support functions

function _validateRepo(repo, manifestPath) {
    var errs = [];

    var keys = new Set(Object.keys(repo));
    if (!keys.has('name')) {
        errs.push(
            new VError(
                'repo in manifest "%s" is missing "name": %j',
                manifestPath,
                repo
            )
        );
    }
    keys.delete('name');
    keys.delete('labels');
    if (keys.size !== 0) {
        errs.push(
            new VError(
                'repo in manifest "%s" has unexpected attributes "%s": %j',
                manifestPath,
                Array.from(keys).join('", "'),
                repo
            )
        );
    }

    return VError.errorFromList(errs);
}

function _normalizeRepo(repo) {
    if (!repo.labels) {
        repo.labels = {};
    }

    // URLs.
    //
    // First we currently assume all repos are on GitHub and under the "joyent"
    // org.
    //
    // For comparison, the GitHub v3 API has the following var names the various
    // URLs:
    //    "html_url": "https://github.com/TritonDataCenter/node-kstat",
    //    "git_url": "git://github.com/TritonDataCenter/node-kstat.git",
    //    "ssh_url": "git@github.com:TritonDataCenter/node-kstat.git",
    //    "clone_url": "https://github.com/TritonDataCenter/node-kstat.git",
    //    "svn_url": "https://github.com/TritonDataCenter/node-kstat",
    repo.htmlUrl = format('https://github.com/TritonDataCenter/%s', repo.name);
    repo.sshCloneUrl = format(
        'git@github.com:TritonDataCenter/%s.git',
        repo.name
    );
    repo.httpsCloneUrl = format(
        'https://github.com/TritonDataCenter/%s.git',
        repo.name
    );

    return repo;
}

/*
 * Parse a label selector string (e.g. `!foo`, `check=42`, `service=*`) into
 * an object with the fields `op`, `key`, `value`.
 */
function _parseLabelSelector(ls) {
    assert.string(ls, 'ls');
    assert.ok(ls.length > 0);

    var KEY_RE = /^[a-z_][a-z0-9\-_.]*/i;
    var OP_RE = /^(!=|=)/;
    var s = ls.trim(); // Remainder of the label selector (ls) being parsed.
    var match;
    var selector;

    if (s[0] === '!') {
        // `!key`
        s = s.slice(1).trimLeft();
        match = KEY_RE.exec(s);
        if (!match) {
            throw new VError('invalid label selector: %j', ls);
        } else if (match[0] !== s) {
            // Didn't match the rest of the string, that's not right.
            throw new VError(
                'invalid label selector, leftover %j: %j',
                s.slice(match[0].length),
                ls
            );
        } else {
            selector = {
                op: 'falsey',
                key: match[0]
            };
        }
    } else {
        match = KEY_RE.exec(s);
        if (!match) {
            throw new VError('invalid label selector: %j', ls);
        }
        var key = match[0];
        s = s.slice(key.length).trimLeft();
        if (s.length === 0) {
            selector = {
                op: 'truthy',
                key: key
            };
        } else {
            match = OP_RE.exec(s);
            if (!match) {
                throw new VError(
                    'invalid label selector, could not match operator ' +
                        'at %j: %j',
                    s,
                    ls
                );
            }
            var op = match[0];
            var value = s.slice(op.length).trimLeft();
            if (value.length === 0) {
                throw new VError(
                    'invalid label selector, value is empty: %j',
                    ls
                );
            }

            // Type conversion to number or boolean.
            var num = Number(value);
            if (!isNaN(num)) {
                value = num;
            } else if (value === 'true') {
                value = true;
            } else if (value === 'false') {
                value = false;
            }

            selector = {
                op: op,
                key: key,
                value: value
            };
        }
    }

    assert.object(selector, 'selector');
    return selector;
}

/*
 * Return true if the given labels object is matched by the given selector.
 * Selector is an object of the form from `_parseLabelSelector`.
 */
function _selectorMatch(labels, selector) {
    var val = labels[selector.key];
    var match;

    switch (selector.op) {
        case 'truthy':
            match = Boolean(val);
            break;
        case 'falsey':
            match = !val;
            break;
        case '!=':
            if (val === undefined) {
                match = true;
            } else if (
                typeof val !== 'string' ||
                typeof selector.value !== 'string'
            ) {
                match = val.toString() !== selector.value.toString();
            } else {
                match = !minimatch(val, selector.value, {
                    noglobstar: true,
                    dot: true,
                    nocomment: true,
                    nonegate: true
                });
            }
            break;
        case '=':
            if (val === undefined) {
                match = false;
            } else if (
                typeof val !== 'string' ||
                typeof selector.value !== 'string'
            ) {
                match = val.toString() === selector.value.toString();
            } else {
                match = minimatch(val, selector.value, {
                    noglobstar: true,
                    dot: true,
                    nocomment: true,
                    nonegate: true
                });
            }
            break;
        default:
            throw new VError('invalid selector op: %j', selector.op);
    }

    assert.bool(match, 'match');
    return match;
}

function JoyentReposManager(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.arrayOfString(opts.manifestPaths, 'opts.manifestPaths');

    this.manifestPaths = opts.manifestPaths;

    // Make sure a given bunyan logger has reasonable client_re[qs] serializers.
    // Note: This was fixed in restify, then broken again in
    // https://github.com/mcavage/node-restify/pull/501
    if (
        opts.log.serializers &&
        (!opts.log.serializers.client_req || !opts.log.serializers.client_req)
    ) {
        this.log = opts.log.child({
            serializers: restifyBunyanSerializers
        });
    } else {
        this.log = opts.log;
    }
}

JoyentReposManager.prototype._loadManifests = function _loadManifests(cb) {
    assert.func(cb, 'cb');

    var self = this;
    var repoFromName = new Map();

    vasync.forEachParallel(
        {
            inputs: self.manifestPaths,
            func: function loadManifest(manifestPath, next) {
                fs.readFile(manifestPath, 'utf8', function onRead(
                    readErr,
                    content
                ) {
                    if (readErr) {
                        next(
                            new VError(
                                readErr,
                                'could not read repos manifest "%s"',
                                manifestPath
                            )
                        );
                        return;
                    }

                    var manifest;
                    try {
                        manifest = JSON.parse(content);
                    } catch (parseErr) {
                        next(
                            new VError(
                                parseErr,
                                'repos manifest "%s" is not valid JSON',
                                manifestPath
                            )
                        );
                        return;
                    }
                    // TODO: validate the manifest (schema would be nice)

                    var repos = manifest.repositories;
                    var defaults = manifest.defaults;

                    for (var i = 0; i < repos.length; i++) {
                        var repo = repos[i];
                        repo.labels = jsprim.mergeObjects(
                            repo.labels,
                            undefined,
                            defaults.labels
                        );
                        var valErr = _validateRepo(repo, manifestPath);
                        if (valErr) {
                            next(valErr);
                            return;
                        }
                        _normalizeRepo(repo);

                        var existingRepo = repoFromName.get(repo.name);
                        if (existingRepo) {
                            // Merge labels. Error out on conflicting label
                            // value for now.
                            var newLabelNames = Object.keys(repo.labels);
                            for (var ln of newLabelNames) {
                                var lv = repo.labels[ln];
                                var existingLv = existingRepo.labels[ln];
                                if (existingLv === undefined) {
                                    existingRepo.labels[ln] = lv;
                                } else if (existingLv !== lv) {
                                    next(
                                        new VError(
                                            'conflicting label "%s" for ' +
                                                'repo "%s": %j vs %j',
                                            ln,
                                            repo.name,
                                            existingRepo.labels,
                                            repo.labels
                                        )
                                    );
                                    return;
                                }
                            }
                        } else {
                            repoFromName.set(repo.name, repo);
                        }
                    }

                    next();
                });
            }
        },
        function doneLoad(err) {
            if (err) {
                cb(err);
            } else {
                var repos = Array.from(repoFromName.values());
                cb(null, repos);
            }
        }
    );
};

/*
 * List repos loaded from the configured manifests (with some filtering).
 *
 * All manifests are loaded and from them the full list of repos. Then
 * the list is filtered by given `opts.names`. Any named repos in this
 * array are included (globbing is supported), e.g.:
 *
 *      jr list rfd sdc-*
 *
 * Then the list is filtered by given `opts.labelSelectors`. These are an
 * array of AND'd selectors that match against each repo's labels.
 * `labelSelectors` support a syntax that is (a) similar and (b) a subset of
 * https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/
 *
 *  - `key = value` uses strict JS comparison (`===`)
 *  - `key != value` uses strict JS comparison (`!==`)
 *  - `key` matches if key is present and value is truthy
 *  - `!key` matches if key is not present or key value is falsey
 *
 * The `value` matching supports globbing. Examples:
 *
 *      jr list -l triton
 *      jr list -l lang=js
 *
 * Limitations: Don't support numeric greater-than, less-than. Don't support
 * set operations. Don't support 'OR'ing.
 */
JoyentReposManager.prototype.listRepos = function listRepos(opts, cb) {
    assert.object(opts, 'opts');
    assert.optionalArrayOfString(opts.names, 'opts.names');
    assert.optionalArrayOfString(opts.labelSelectors, 'opts.labelSelectors');
    assert.func(cb, 'cb');

    var self = this;
    var log = this.log;
    var repos = null;

    // Normalize names. It is common to take them as CLI args, so let's drop
    // trailing path separators.
    var names = [];
    if (opts.names) {
        names = opts.names.map(function onName(name) {
            if (name && name[name.length - 1] === '/') {
                name = name.slice(0, -1);
            }
            return name;
        });
    }

    vasync.pipeline(
        {
            arg: {},
            funcs: [
                function load(ctx, next) {
                    self._loadManifests(function onLoaded(err, repos_) {
                        if (err) {
                            next(err);
                        } else {
                            repos = repos_;
                            ctx.nAllRepos = repos.length;
                            next();
                        }
                    });
                },
                function filterNames(ctx, next) {
                    if (names.length === 0) {
                        next();
                        return;
                    }

                    var repoFromName = {};
                    for (var name of names) {
                        for (var repo of repos) {
                            var match = minimatch(repo.name, name, {
                                noglobstar: true,
                                dot: true,
                                nocomment: true,
                                nonegate: true
                            });
                            if (match) {
                                repoFromName[repo.name] = repo;
                            }
                        }
                    }
                    repos = Object.keys(repoFromName).map(function aName(n) {
                        return repoFromName[n];
                    });

                    log.debug(
                        {names: names},
                        'filterNames from %d to %d repos',
                        ctx.nAllRepos,
                        repos.length
                    );
                    next();
                },
                function determineSelectors(ctx, next) {
                    ctx.selectors = [];

                    if (opts.labelSelectors) {
                        for (let ls of opts.labelSelectors) {
                            let selector;
                            try {
                                selector = _parseLabelSelector(ls);
                            } catch (parseErr) {
                                next(parseErr);
                                return;
                            }
                            ctx.selectors.push(selector);
                        }
                    }

                    next();
                },
                function filterSelectors(ctx, next) {
                    for (let selector of ctx.selectors) {
                        var nBefore = repos.length;
                        repos = repos.filter(function aRepo(repo) {
                            return _selectorMatch(repo.labels, selector);
                        });

                        log.debug(
                            {selector: selector},
                            'filterLabelSelector from %d to %d repos',
                            nBefore,
                            repos.length
                        );
                    }

                    next();
                }
            ]
        },
        function doneList(err) {
            if (err) {
                cb(err);
            } else {
                cb(null, repos);
            }
        }
    );
};

/*
 * Clone the given repo into the given directory. If the repo is already
 * cloned to that directory (the dir exists and git remote url for "origin"
 * matches), then this is a successful no-op.
 *
 * @param {Object} `opts`
 * @param {Function} `cb` - `function (err, alreadyCloned)`. On failure,
 *      `err` is an error instance. On success, `err` is null and
 *      `alreadyCloned` is a boolean indicating if the repo was already
 *      cloned to that dir.
 */
JoyentReposManager.prototype.cloneRepo = function cloneRepo(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.repo, 'opts.repo');
    assert.string(opts.dir, 'opts.dir');

    var alreadyCloned = null;

    vasync.pipeline(
        {
            funcs: [
                function dirExists(_, next) {
                    fs.stat(opts.dir, function onStat(err, stats) {
                        if (err && err.code === 'ENOENT') {
                            alreadyCloned = false;
                            next();
                        } else if (err) {
                            next(
                                new VError(
                                    err,
                                    'unexpected error checking if "%s" exists',
                                    opts.dir
                                )
                            );
                        } else if (!stats.isDirectory()) {
                            next(
                                new VError(
                                    err,
                                    '"%s" exists and is not a directory',
                                    opts.dir
                                )
                            );
                        } else {
                            next();
                        }
                    });
                },
                function dirIsCloneOfRepo(_, next) {
                    if (alreadyCloned === false) {
                        next();
                        return;
                    }

                    // `dir` is an existing directory. Is it a clone of
                    // our repo?
                    // Limitation: This could be tricked by `git -C $dir ...`
                    // walking *up* dirs to find the ".git" root.
                    forkExecWait(
                        {
                            argv: [
                                'git',
                                '-C',
                                opts.dir,
                                'remote',
                                'get-url',
                                'origin'
                            ]
                        },
                        function onExec(err, info) {
                            if (err) {
                                next(
                                    new VError(
                                        err,
                                        '"%s" exists and is not a git ' +
                                            'clone of repo "%s"',
                                        opts.dir,
                                        opts.repo.name
                                    )
                                );
                            } else {
                                var url = info.stdout.trim();
                                if (
                                    url === opts.repo.sshCloneUrl ||
                                    url === opts.repo.httpsCloneUrl
                                ) {
                                    alreadyCloned = true;
                                    next();
                                } else {
                                    next(
                                        new VError(
                                            err,
                                            '"%s" is a clone of a repo other ' +
                                                'than "%s": origin url is "%s"',
                                            opts.dir,
                                            opts.repo.name,
                                            url
                                        )
                                    );
                                }
                            }
                        }
                    );
                },
                function doTheClone(_, next) {
                    if (alreadyCloned) {
                        next();
                        return;
                    }

                    forkExecWait(
                        {
                            argv: [
                                'git',
                                'clone',
                                opts.repo.sshCloneUrl,
                                opts.dir
                            ]
                        },
                        function onExec(err, _info) {
                            next(err);
                        }
                    );
                }
            ]
        },
        function doneClone(err) {
            if (err) {
                cb(err);
            } else {
                assert.bool(alreadyCloned, 'alreadyCloned');
                cb(null, alreadyCloned);
            }
        }
    );
};

/*
 * Call to clone a number of repos. This returns an event emitter:
 *
 * - 'end' is emitted when done
 * - 'progress' is emitted for each completed repo, with args `err` and `info`.
 *   `err` is null if cloning was successful. `info` is an object with these
 *   fields:
 *      - `repo`: the given repo object
 *      - `dir`: the clone directory
 *      - `elapsed`: The time it took to clone, in `process.hrtime()` format.
 *        Only meaningful if the repo was successfully cloned.
 *      - `alreadyCloned`: True if the repo already cloned.
 *        Only meaningful if the repo was successfully cloned.
 */
JoyentReposManager.prototype.cloneRepos = function cloneRepos(opts) {
    assert.object(opts, 'opts');
    assert.arrayOfObject(opts.repos, 'opts.repos');
    assert.string(opts.baseDir, 'opts.baseDir');
    assert.optionalNumber(opts.concurrency, 'opts.concurrency');

    var self = this;
    var concurrency = jsprim.hasKey(opts, 'concurrency')
        ? opts.concurrency
        : DEFAULT_CONCURRENCY;

    var q = vasync.queue(function cloneARepo(repo, cb) {
        var start = process.hrtime();
        var dir = self.getRepoPath(opts.baseDir, repo.name);

        self.cloneRepo(
            {
                repo: repo,
                dir: dir
            },
            function onCloned(cloneErr, alreadyCloned) {
                var info = {
                    repo: repo,
                    dir: dir,
                    elapsed: process.hrtime(start)
                };
                if (alreadyCloned !== undefined) {
                    info.alreadyCloned = alreadyCloned;
                }
                cb(cloneErr, info);
            }
        );
    }, concurrency);

    // TODO: update vasync.queue docs to (a) show example using 'end' event
    // and (b) show that the args to optional `q.push` callback are those
    // from the queued task.

    q.push(opts.repos, function doneARepo(err, info) {
        q.emit('progress', err, info);
    });
    q.close();

    return q;
};

/*
 * Call to exec a command in a number of repo clones.
 * This returns an event emitter:
 *
 * - 'end' is emitted when done
 * - 'progress' is emitted for each completed repo, with args `err` and `info`.
 *   `err` is null if the exec was successful. `info` is an object with these
 *   fields:
 *      - `repo`: the given repo object
 *      - `dir`: the clone directory
 *      - `elapsed`: The time it took to exec, in `process.hrtime()` format.
 *      - `error`, `status`, `signal`, `stdout`, and `stderr` all from
 *        https://github.com/TritonDataCenter/node-forkexec#callback
 *
 * TODO: pass on other args (https://github.com/TritonDataCenter/node-forkexec#arguments)
 */
JoyentReposManager.prototype.execInClones = function execInClones(opts) {
    assert.object(opts, 'opts');
    assert.arrayOfObject(opts.repos, 'opts.repos');
    assert.string(opts.baseDir, 'opts.baseDir');
    assert.string(opts.cmd, 'opts.cmd');
    assert.optionalNumber(opts.concurrency, 'opts.concurrency');

    var self = this;
    var concurrency = jsprim.hasKey(opts, 'concurrency')
        ? opts.concurrency
        : DEFAULT_CONCURRENCY;

    var q = vasync.queue(function execInClone(repo, cb) {
        var start = process.hrtime();
        var dir = self.getRepoPath(opts.baseDir, repo.name);

        forkExecWait(
            {
                argv: ['/bin/bash', '-c', opts.cmd],
                cwd: dir
            },
            function onExec(err, info) {
                info.repo = repo;
                info.dir = dir;
                info.elapsed = process.hrtime(start);
                cb(err, info);
            }
        );
    }, concurrency);

    q.push(opts.repos, function doneARepo(err, info) {
        q.emit('progress', err, info);
    });
    q.close();

    return q;
};

/*
 * Return the local directory for this repository. Users can set
 * $JR_REPO_PATH_SUFFIX to give all their repositories a consistent suffix,
 * e.g. <repo_name>.git
 */
JoyentReposManager.prototype.getRepoPath = function getRepoPath(
    baseDir,
    repoName
) {
    assert.string(baseDir, 'baseDir');
    assert.string(repoName, 'repoName');
    var repo_path = path.join(baseDir, repoName);
    if (process.env.JR_REPO_PATH_SUFFIX !== undefined) {
        repo_path += process.env.JR_REPO_PATH_SUFFIX;
    }
    return repo_path;
};

module.exports = {
    JoyentReposManager: JoyentReposManager
};

// vim: set softtabstop=4 shiftwidth=4:
