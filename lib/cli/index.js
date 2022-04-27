/*
 * Copyright 2019 Joyent, Inc.
 * Copyright 2022 MNX Cloud, Inc.
 *
 * The `jr` CLI class.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
var fs = require('fs');
var mkdirp = require('mkdirp');
var path = require('path');
var restifyClients = require('restify-clients');
var util = require('util');
var vasync = require('vasync');

var common = require('../common');
var clicommon = require('./clicommon');
var libJr = require('../');

// ---- globals

var packageJson = require('../../package.json');

var CACHE_DIR = '~/.jr/cache';

var OPTIONS = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit.'
    },
    {
        name: 'version',
        type: 'bool',
        help: 'Print version and exit.'
    },
    {
        names: ['verbose', 'v'],
        type: 'bool',
        help: 'Verbose/debug output.'
    },
    {
        names: ['manifest', 'm'],
        type: 'arrayOfCommaSepString',
        helpArg: 'PATH',
        env: 'JR_MANIFESTS',
        help: 'Repo manifest paths (comma-separated).'
    },
    {
        names: ['color'],
        type: 'bool',
        help: 'Colorize output. This is the default on a tty.'
    },
    {
        names: ['no-color'],
        env: 'JR_NO_COLOR',
        type: 'bool',
        help: 'Force no coloring of output.'
    }
];

// ---- other support stuff

function parseCommaSepStringNoEmpties(_option, _optstr, arg) {
    return arg
        .trim()
        .split(/\s*,\s*/g)
        .filter(function onPart(part) {
            return part;
        });
}

cmdln.dashdash.addOptionType({
    name: 'commaSepString',
    takesArg: true,
    helpArg: 'STRING',
    parseArg: parseCommaSepStringNoEmpties
});

cmdln.dashdash.addOptionType({
    name: 'arrayOfCommaSepString',
    takesArg: true,
    helpArg: 'STRING',
    parseArg: parseCommaSepStringNoEmpties,
    array: true,
    arrayFlatten: true
});

// ---- CLI class

function JoyentReposCli() {
    Cmdln.call(this, {
        name: 'jr',
        desc: [
            'List, clone, maintain, and use Joyent repos.',
            '',
            'This is a command to work with a set of repos defined by one or',
            'more manifests (typically called "jr-manifest.json"). Currently',
            'the tool assumes all repos are Joyent repos on GitHub. See',
            'https://github.com/TritonDataCenter/joyent-repos for setup',
            'details and an introduction.'
        ].join('\n'),
        options: OPTIONS,
        helpOpts: {
            includeEnv: true,
            minHelpCol: 30
        },
        helpSubcmds: [
            'help',
            'completion',

            {group: 'Manifest maintenance'},
            'update-manifest',

            {group: 'Use repo manifest info'},
            'list',
            'clone',

            {group: 'Act on repo clones'},
            'oneach',
            'pull',

            {group: 'Maintain GitHub repo settings'},
            'github-settings'
        ]
    });
}
util.inherits(JoyentReposCli, Cmdln);

JoyentReposCli.prototype.init = function init(opts, args, callback) {
    this.opts = opts;

    this.log = bunyan.createLogger({
        name: this.name,
        serializers: restifyClients.bunyan.serializers,
        stream: process.stderr,
        level: 'warn'
    });
    if (opts.verbose) {
        this.log.level('trace');
        this.log.src = true;
        this.showErrStack = true;
    }

    if (opts.version) {
        console.log('jr', packageJson.version);
        console.log(packageJson.homepage);
        callback(false);
        return;
    }

    this.stylize = clicommon.ansiStylizerFromDashdashOpts(this.opts);

    var manifestPaths = [];
    for (var p of opts.manifest || []) {
        manifestPaths.push(common.tildeSync(p));
    }
    this.log.trace({manifestPaths: manifestPaths}, 'manifestPaths');
    this.jrm = libJr.createJoyentReposManager({
        manifestPaths: manifestPaths,
        log: this.log
    });

    if (process.env.JR_COMPLETE) {
        /*
         * If `JR_COMPLETE=<type>` is set (typically only in the
         * CLI bash completion driver, see
         * "etc/jr-bash-completion-types.sh"), then Bash completions are
         * fetched and printed, instead of the usual subcommand handling.
         *
         * Completion results are typically cached (under "~/.triton/cache")
         * to avoid exec'ing this node program everytime.
         *
         * Example usage:
         *      JR_COMPLETE=jrrepo jr ls
         */
        this.showErrStack = true; // XXX
        this._emitCompletions(process.env.JR_COMPLETE, function(err) {
            callback(err || false);
        });
    } else {
        // Cmdln class handles `opts.help`.
        Cmdln.prototype.init.call(this, opts, args, callback);
    }
};

JoyentReposCli.prototype.fini = function fini(subcmd, err, cb) {
    this.log.trace({err: err, subcmd: subcmd}, 'cli fini');
    cb();
};

/*
 * Fetch and display Bash completions (one completion per line) for the given
 * data type. This caches results with a 5 minute TTL.
 *
 XXX
 * Dev Note: If the cache path logic changes, then the *Bash* implementation
 * of the same logic in "etc/triton-bash-completion-types.sh" must be updated
 * to match.
 */
JoyentReposCli.prototype._emitCompletions = function _emitCompletions(
    type,
    cb
) {
    assert.string(type, 'type');
    assert.func(cb, 'cb');

    var cacheFile = path.join(
        common.tildeSync(CACHE_DIR),
        type + '.completions'
    );
    var ttl = 5 * 60 * 1000; // timeout of cache file info (ms)
    var jrm = this.jrm;

    vasync.pipeline(
        {
            arg: {},
            funcs: [
                function tryCacheFile(_, next) {
                    fs.stat(cacheFile, function(err, stats) {
                        if (
                            !err &&
                            stats.mtime.getTime() + ttl >= new Date().getTime()
                        ) {
                            process.stdout.write(fs.readFileSync(cacheFile));
                            next(true); // early abort
                        } else if (err && err.code !== 'ENOENT') {
                            next(err);
                        } else {
                            next();
                        }
                    });
                },

                function gather(ctx, next) {
                    var completions;

                    switch (type) {
                        case 'jrrepo':
                            jrm.listRepos({}, function onList(err, repos) {
                                if (err) {
                                    next(err);
                                    return;
                                }
                                completions = repos.map(function aRepo(r) {
                                    return r.name;
                                });
                                ctx.completions = completions.join('\n') + '\n';
                                next();
                            });
                            break;
                        default:
                            process.stderr.write(
                                'warning: unknown jr completion type: ' +
                                    type +
                                    '\n'
                            );
                            next();
                            break;
                    }
                },

                function makeCacheDir(arg, next) {
                    if (!arg.completions) {
                        next();
                        return;
                    }
                    mkdirp(path.dirname(cacheFile), next);
                },

                function saveCache(arg, next) {
                    if (!arg.completions) {
                        next();
                        return;
                    }
                    fs.writeFile(cacheFile, arg.completions, next);
                },

                function emit(arg, next) {
                    if (arg.completions) {
                        console.log(arg.completions);
                    }
                    next();
                }
            ]
        },
        function(err) {
            if (err === true) {
                // early abort signal
                err = null;
            }
            cb(err);
        }
    );
};

JoyentReposCli.prototype.warnUnconfigured = function warnUnconfigured() {
    this.warn(
        [
            /* eslint-disable max-len */
            '',
            'Warning: No repos were listed likely because the JR_MANIFESTS envvar is not set.',
            'Use JR_MANIFESTS, or the `-m PATHS` option, to point to jr-manifest.json files.',
            'A typical Triton eng setup:',
            '   git clone git@github.com:TritonDataCenter/triton.git',
            '   export JR_MANIFESTS=`pwd`/triton/tools/jr-manifest.json'
            /* eslint-enable max-len */
        ].join('\n')
    );
};
JoyentReposCli.prototype.warn = function warn(msg) {
    console.error(this.stylize(msg, 'red'));
};

JoyentReposCli.prototype.do_completion = require('./do_completion');

JoyentReposCli.prototype.do_update_manifest = require('./do_update_manifest');

JoyentReposCli.prototype.do_list = require('./do_list');
JoyentReposCli.prototype.do_clone = require('./do_clone');

JoyentReposCli.prototype.do_oneach = require('./do_oneach');
JoyentReposCli.prototype.do_pull = require('./do_pull');

JoyentReposCli.prototype.do_github_settings = require('./github_settings/index.js');

// ---- mainline

function main(argv) {
    var cli = new JoyentReposCli();
    cmdln.main(cli, {
        argv: argv || process.argv
    });
}

// ---- exports

module.exports = {
    main: main
};
