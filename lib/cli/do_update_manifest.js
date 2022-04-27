/*
 * Copyright (c) 2018, Joyent, Inc.
 * Copyright 2022 MNX Cloud, Inc.
 *
 * `jr update-manifest MANIFEST`
 */

var assert = require('assert-plus');
var format = require('util').format;
var fs = require('fs');
var tabula = require('tabula');
var UsageError = require('cmdln').UsageError;
const {Octokit} = require('@octokit/rest');
var vasync = require('vasync');
var VError = require('verror');

var common = require('../common');

var jrVersion = require('../../package.json').version;

var JOYENT_REPO_BASE_URL = 'https://github.com/TritonDataCenter/';
var DEBUG_GITHUB_REPOS_CACHE_PATH = null; // set to a local path to cache
// DEBUG_GITHUB_REPOS_CACHE_PATH = '/tmp/ghrepos.json';

function saveManifest(manifestPath, manifest, cb) {
    var str = JSON.stringify(manifest, null, 4) + '\n';
    fs.writeFile(manifestPath, str, 'utf8', function onSave(err) {
        if (err) {
            cb(err);
        } else {
            console.log('Updated "%s".', manifestPath);
            cb();
        }
    });
}

function do_update_manifest(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length < 1) {
        cb(new UsageError('missing MANIFEST argument'));
        return;
    } else if (args.length > 1) {
        cb(new UsageError('too many arguments'));
        return;
    }

    var self = this;
    var manifestPath = args[0];
    var log = self.log.child({octokit: true}, true);
    var octokit = Octokit({
        auth: process.env.GITHUB_TOKEN,
        userAgent: 'jr ' + jrVersion,
        // https://octokit.github.io/rest.js/v17#logging
        log: {
            debug: function(msg, info) {
                log.debug({octokitInfo: info}, msg);
            },
            info: function(msg, info) {
                log.info({octokitInfo: info}, msg);
            },
            warn: function(msg, info) {
                log.warn({octokitInfo: info}, msg);
            },
            error: function(msg, info) {
                log.error({octokitInfo: info}, msg);
            }
        }
    });

    vasync.pipeline(
        {
            arg: {},
            funcs: [
                function readManifest(ctx, next) {
                    fs.readFile(manifestPath, 'utf8', function(err, content) {
                        if (err) {
                            next(new VError(err, 'could not read manifest'));
                            return;
                        }
                        try {
                            ctx.manifest = JSON.parse(content);
                        } catch (parseErr) {
                            next(
                                new VError(
                                    parseErr,
                                    'repo manifest "%s" is not valid JSON',
                                    manifestPath
                                )
                            );
                            return;
                        }
                        next();
                    });
                },

                function fetchCandidateRepos(ctx, next) {
                    if (
                        DEBUG_GITHUB_REPOS_CACHE_PATH &&
                        fs.existsSync(DEBUG_GITHUB_REPOS_CACHE_PATH)
                    ) {
                        next();
                        return;
                    }

                    assert.string(
                        ctx.manifest.repoCandidateSearch.type,
                        'manifest ' +
                            manifestPath +
                            ' "repoCandidateSearch.type"'
                    );

                    console.log('Gathering candidate repos from GitHub.');
                    var reqOpts = octokit.repos.listForOrg.endpoint.merge({
                        org: 'joyent',
                        type: ctx.manifest.repoCandidateSearch.type
                    });
                    octokit
                        .paginate(reqOpts)
                        .then(function(repos) {
                            ctx.candidateRepos = repos;

                            // Unless manifest.repoCandidateSearch says to include
                            // archived repos, we will drop them.
                            if (
                                !ctx.manifest.repoCandidateSearch
                                    .includeArchived
                            ) {
                                ctx.candidateRepos = ctx.candidateRepos.filter(
                                    function(repo) {
                                        return !repo.archived;
                                    }
                                );
                            }

                            next();
                        })
                        .catch(function(err) {
                            // Avoid deprecation warning by wrapping the error
                            // but still allowing cmdln to use `err.code`.
                            //   Deprecation: [@octokit/request-error] `error.code` is deprecated, use `error.status`.
                            next(
                                new VError(
                                    {
                                        name: 'GitHubApiError',
                                        cause: err,
                                        code: err.status
                                    },
                                    'error calling GitHub API'
                                )
                            );
                        });
                },

                function cacheIt(ctx, next) {
                    if (DEBUG_GITHUB_REPOS_CACHE_PATH && ctx.candidateRepos) {
                        fs.writeFile(
                            DEBUG_GITHUB_REPOS_CACHE_PATH,
                            JSON.stringify(ctx.candidateRepos),
                            'utf8',
                            next
                        );
                    } else {
                        next();
                    }
                },
                function loadCache(ctx, next) {
                    if (DEBUG_GITHUB_REPOS_CACHE_PATH && !ctx.candidateRepos) {
                        console.log('Loading GitHub repos from cache.');
                        fs.readFile(
                            DEBUG_GITHUB_REPOS_CACHE_PATH,
                            'utf8',
                            function(err, data) {
                                ctx.candidateRepos = JSON.parse(data);
                                next(err);
                            }
                        );
                    } else {
                        next();
                    }
                },

                function categorizeRepos(ctx, next) {
                    ctx.categories = {
                        gone: [],
                        new: []
                    };

                    var name;
                    var repo;
                    var repoFromName = {};
                    for (repo of ctx.manifest.repositories) {
                        repoFromName[repo.name] = repo;
                    }
                    var excRepoFromName = {};
                    for (name of ctx.manifest.excludedRepositories) {
                        excRepoFromName[name] = true;
                    }
                    var candidateRepoFromName = {};
                    for (repo of ctx.candidateRepos) {
                        candidateRepoFromName[repo.name] = repo;
                    }

                    // Entries in manifest.repositories that are no longer
                    // in the query results.
                    ctx.goneRepos = [];
                    for (repo of ctx.manifest.repositories) {
                        if (!candidateRepoFromName[repo.name]) {
                            ctx.goneRepos.push(repo);
                        }
                    }

                    // Entries in manifest.excludedRepositories that are no longer
                    // in the query results.
                    ctx.goneExcRepos = [];
                    for (name of ctx.manifest.excludedRepositories) {
                        if (!candidateRepoFromName[name]) {
                            ctx.goneExcRepos.push({name: name});
                        }
                    }

                    // New candidate repos.
                    ctx.newRepos = [];
                    for (repo of ctx.candidateRepos) {
                        if (
                            !repoFromName[repo.name] &&
                            !excRepoFromName[repo.name]
                        ) {
                            ctx.newRepos.push(repo);
                        }
                    }

                    next();
                },

                function removeGoneRepos(ctx, next) {
                    var repos = ctx.goneRepos.concat(ctx.goneExcRepos);
                    if (repos.length === 0) {
                        console.log(
                            'No newly archived repos to remove from the manifest.'
                        );
                        next();
                        return;
                    }

                    var msg = format(
                        [
                            '',
                            '* * *',
                            'The following %d repo(s) have been archived, or are otherwise no longer',
                            'candidate repos for "%s":',
                            '    %s',
                            'Remove them from the manifest? [Y/n] '
                        ].join('\n'),
                        repos.length,
                        manifestPath,
                        repos
                            .map(function(r) {
                                return r.name;
                            })
                            .join('\n    ')
                    );
                    common.promptYesNo({msg: msg, default: 'y'}, function onA(
                        answer
                    ) {
                        if (answer !== 'y') {
                            console.error('Skipping removal of archived repos');
                            next();
                        } else {
                            var goneRepoNames = new Set(
                                ctx.goneRepos.map(function aRepo(r) {
                                    return r.name;
                                })
                            );
                            ctx.manifest.repositories = ctx.manifest.repositories.filter(
                                function aRepo(r) {
                                    return !goneRepoNames.has(r.name);
                                }
                            );

                            var goneExcRepoNames = new Set(
                                ctx.goneExcRepos.map(function aRepo(r) {
                                    return r.name;
                                })
                            );
                            ctx.manifest.excludedRepositories = ctx.manifest.excludedRepositories.filter(
                                function aName(n) {
                                    return !goneExcRepoNames.has(n);
                                }
                            );

                            saveManifest(manifestPath, ctx.manifest, next);
                        }
                    });
                },

                function confirmAddNewRepos(ctx, next) {
                    if (ctx.newRepos.length === 0) {
                        console.log('No new repos to add to the manifest.');
                        ctx.addNewRepos = false;
                        next();
                        return;
                    }

                    var reposRepr = [];
                    if (ctx.newRepos.length >= 10) {
                        reposRepr = ctx.newRepos
                            .slice(0, 9)
                            .map(function aRepo(r) {
                                return r.name;
                            });
                        reposRepr.push('...');
                    } else {
                        reposRepr = ctx.newRepos.map(function aRepo(r) {
                            return r.name;
                        });
                    }
                    var msg = format(
                        [
                            /* eslint-disable max-len */
                            '',
                            '* * *',
                            'There are %d candidate new repo(s) to work through:',
                            '    %s',
                            '',
                            'The manifest defines relevant repos as follows:',
                            '    %s',
                            '',
                            'The process is:',
                            '1. edit the list of repos to include in this manifest',
                            '   (possibly including additional labels)',
                            '2. edit the list of repos to exclude as not relevant',
                            '3. any left over repos are deferred until the next',
                            '   `jr update-manifest ...`',
                            ''
                            /* eslint-enable max-len */
                        ].join('\n'),
                        ctx.newRepos.length,
                        reposRepr.join('\n    '),
                        ctx.manifest.repoCandidateSearch.description
                    );
                    console.log(msg);

                    var prompt =
                        'Hit <Enter> to edit inclusions (step 1), <Ctrl+C> to abort.';
                    common.promptEnter(prompt, function onA(err) {
                        if (err) {
                            console.log('\nSkipping adding new repos.');
                            ctx.addNewRepos = false;
                        } else {
                            ctx.addNewRepos = true;
                            ctx.remainingRepos = ctx.newRepos.slice();
                        }
                        next();
                    });
                },

                function addNewIncludedRepos(ctx, next) {
                    if (!ctx.addNewRepos) {
                        next();
                        return;
                    }

                    var frontMatter = [
                        /* eslint-disable max-len */
                        '# Uncomment any repos that should be *included* as relevant',
                        '# for this manifest.',
                        '#',
                        '# Optionally you may include a space-separate set of labels after',
                        '# a repo to label it (KEY=VALUE or KEY for a bool), e.g.:',
                        '#     https://github.com/TritonDataCenter/sdc-imgapi tritonservice=imgapi vm',
                        '#     https://github.com/TritonDataCenter/triton-cmon-agent tritonservice=cmon-agent agent'
                        /* eslint-enable max-len */
                    ];
                    if (ctx.manifest.defaults && ctx.manifest.defaults.labels) {
                        frontMatter.push('#');
                        frontMatter.push('# Default labels:');
                        var dl = ctx.manifest.defaults.labels;
                        for (var k of Object.keys(dl)) {
                            var v = dl[k];
                            if (v === true) {
                                frontMatter.push('# - ' + k);
                            } else {
                                frontMatter.push('# - ' + k + '=' + v);
                            }
                        }
                    }
                    if (
                        ctx.manifest.blessedLabels &&
                        ctx.manifest.blessedLabels.length
                    ) {
                        frontMatter.push('#');
                        frontMatter.push('# Blessed labels:');
                        for (var lbl of ctx.manifest.blessedLabels) {
                            if (lbl.type === 'boolean') {
                                frontMatter.push(
                                    '# - ' + lbl.name + ' - ' + lbl.description
                                );
                            } else {
                                frontMatter.push(
                                    '# - ' +
                                        lbl.name +
                                        '=<' +
                                        lbl.type +
                                        '> - ' +
                                        lbl.description
                                );
                            }
                        }
                    }
                    frontMatter.push('');

                    editReposInEditor(
                        {
                            frontMatter: frontMatter,
                            editFilename: 'newIncludeRepos',
                            repos: ctx.remainingRepos,
                            parseLabels: true,
                            log: self.log
                        },
                        function onEdited(err, repos) {
                            if (err) {
                                next(err);
                            } else if (repos.length === 0) {
                                console.log('No new repos to include.');
                                next();
                            } else {
                                if (!ctx.manifest.repositories) {
                                    ctx.manifest.repositories = [];
                                }
                                ctx.manifest.repositories = ctx.manifest.repositories.concat(
                                    repos
                                );
                                tabula.sortArrayOfObjects(
                                    ctx.manifest.repositories,
                                    ['name']
                                );

                                var addedNames = new Set(
                                    repos.map(function aRepo(r) {
                                        return r.name;
                                    })
                                );
                                ctx.remainingRepos = ctx.remainingRepos.filter(
                                    function aRepo(r) {
                                        return !addedNames.has(r.name);
                                    }
                                );

                                saveManifest(manifestPath, ctx.manifest, next);
                            }
                        }
                    );
                },

                function confirmAddNewExcludedRepos(ctx, next) {
                    if (!ctx.addNewRepos || ctx.remainingRepos.length === 0) {
                        ctx.addNewExcludedRepos = false;
                        next();
                        return;
                    }

                    console.log(
                        [
                            /* eslint-disable max-len */
                            '',
                            '* * *',
                            'Next we will handle *exclusions*, by editing the remaining',
                            'list of repos down to those to be excluded from this manifest.'
                            /* eslint-enable max-len */
                        ].join('\n')
                    );

                    var prompt =
                        'Hit <Enter> to edit exclusions (step 2), <Ctrl+C> to abort.';
                    common.promptEnter(prompt, function onA(err) {
                        if (err) {
                            console.log(
                                '\nSkipping adding new excluded repos.'
                            );
                            ctx.addNewExcludedRepos = false;
                        } else {
                            console.log('');
                            ctx.addNewExcludedRepos = true;
                        }
                        next();
                    });
                },

                function addNewExcludedRepos(ctx, next) {
                    if (!ctx.addNewExcludedRepos) {
                        next();
                        return;
                    }

                    editReposInEditor(
                        {
                            frontMatter: [
                                /* eslint-disable max-len */
                                '# Uncomment any repos that should be *excluded* from this manifest',
                                '# (they will be noted in the "excludedRepositories" field).',
                                ''
                                /* eslint-enable max-len */
                            ],
                            repos: ctx.remainingRepos,
                            editFilename: 'newExcludeRepos',
                            log: self.log
                        },
                        function onEdited(err, repos) {
                            if (err) {
                                next(err);
                            } else if (repos.length === 0) {
                                console.log('No new repos to exclude.');
                                next();
                            } else {
                                if (!ctx.manifest.excludedRepositories) {
                                    ctx.manifest.excludedRepositories = [];
                                }
                                for (var repo of repos) {
                                    ctx.manifest.excludedRepositories.push(
                                        repo.name
                                    );
                                }
                                ctx.manifest.excludedRepositories.sort();
                                saveManifest(manifestPath, ctx.manifest, next);
                            }
                        }
                    );
                }
            ]
        },
        cb
    );
}

function createReposForm(frontMatter, repos) {
    var form = frontMatter ? frontMatter.slice() : [];
    for (var repo of repos) {
        form.push('# ' + JOYENT_REPO_BASE_URL + repo.name);
    }
    return form.join('\n') + '\n';
}

function parseReposForm(text, parseLabels) {
    assert.string(text, 'text');
    assert.optionalBool(parseLabels, 'parseLabels');

    var lines = text.split(/\n/g);
    var repos = [];
    var line;

    for (var i = 0; i < lines.length; i++) {
        line = lines[i].trim();
        if (!line) {
            // fall through
        } else if (line[0] === '#') {
            // fall through (comment)
        } else if (
            line.slice(0, JOYENT_REPO_BASE_URL.length) === JOYENT_REPO_BASE_URL
        ) {
            // $BASE_URL/$name [$label1 $label2 ...]
            var tokens = line.slice(JOYENT_REPO_BASE_URL.length).split(/\s+/g);
            var repo = {name: tokens.shift()};
            if (parseLabels && tokens.length > 0) {
                var labels = {};
                for (var token of tokens) {
                    var idx = token.indexOf('=');
                    if (idx === -1) {
                        labels[token] = true;
                    } else {
                        var key = token.slice(0, idx);
                        var val = token.slice(idx + 1);
                        if (val === 'true') {
                            val = true;
                        } else if (val === 'false') {
                            val = false;
                        } else if (!isNaN(Number(val))) {
                            val = Number(val);
                        }
                        labels[key] = val;
                    }
                }
                repo.labels = labels;
            }
            repos.push(repo);
        } else {
            throw new VError(
                {
                    info: {
                        line: i + 1
                    }
                },
                'line %d is not a github/joyent repo URL: "%s"',
                i + 1,
                line
            );
        }
    }

    return repos;
}

function editReposInEditor(opts, cb) {
    assert.optionalArrayOfString(opts.frontMatter, 'opts.frontMatter');
    assert.object(opts.log, 'opts.log');
    assert.optionalBool(opts.parseLabels, 'opts.parseLabels');
    assert.arrayOfObject(opts.repos, 'opts.repos');
    assert.optionalString(opts.editFilename, 'opts.editFilename');

    var frontMatter = opts.frontMatter || [];
    var editLine = frontMatter.length + 1;
    var text = createReposForm(frontMatter, opts.repos);

    var editAttempt = function editAttempt() {
        common.editInEditor(
            {
                text: text,
                line: editLine,
                log: opts.log,
                filename: opts.editFilename
            },
            function onEditAttempt(editErr, editedText) {
                if (editErr) {
                    cb(editErr);
                    return;
                }

                text = editedText;
                editLine = null;
                var repos;

                try {
                    repos = parseReposForm(editedText, opts.parseLabels);
                } catch (parseErr) {
                    console.error('* * *\nerror: ' + parseErr.message);
                    common.promptEnter(
                        'Press <Enter> to re-edit, <Ctrl+C> to abort.',
                        function onResponse(promptErr) {
                            if (promptErr) {
                                console.error('\nAborting.');
                                cb(true);
                            } else {
                                var errLine = VError.info(parseErr).line;
                                if (errLine) {
                                    editLine = errLine;
                                }
                                setImmediate(editAttempt);
                            }
                        }
                    );
                    return;
                }

                cb(null, repos);
            }
        );
    };

    setImmediate(editAttempt);
}

do_update_manifest.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

do_update_manifest.synopses = ['{{name}} {{cmd}} [OPTIONS] MANIFEST-PATH'];

do_update_manifest.completionArgtypes = ['default', 'none'];

do_update_manifest.help = [
    'Update the repository list in the given manifest.',
    '',
    '{{usage}}',
    '',
    '{{options}}'
].join('\n');

module.exports = do_update_manifest;
