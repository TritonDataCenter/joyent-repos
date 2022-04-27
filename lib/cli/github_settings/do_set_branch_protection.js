/*
 * Copyright 2020 Joyent, Inc.
 * Copyright 2022 MNX Cloud, Inc.
 *
 * `jr github-settings set-branch-protection REPO`
 */

var assert = require('assert-plus');
const {Octokit} = require('@octokit/rest');
var UsageError = require('cmdln').UsageError;
var vasync = require('vasync');
var VError = require('verror');
var version = require('../../../package.json').version;

function getBranchProtection(branchName, ctx, next) {
    assert.string(branchName, 'branchName');
    assert.object(ctx.octokit, 'ctx.octokit');
    assert.object(ctx.log, 'ctx.log');
    assert.string(ctx.repoName, 'ctx.repoName');
    assert.func(next, 'next');

    var octokit = ctx.octokit;
    var log = ctx.log;
    var repoName = ctx.repoName;
    ctx.missingBranch[branchName] = false;

    octokit.repos
        .getBranchProtection({
            owner: 'joyent',
            repo: repoName,
            branch: branchName
        })
        .then(function(res) {
            log.trace({ghRes: res}, 'github api response');
            ctx.protection[branchName] = res.data;
            next();
        })
        .catch(function(err) {
            if (err.message === 'Branch not protected') {
                ctx.protection[branchName] = null;
                next();
            } else if (err.message === 'Branch not found') {
                ctx.changeRequired[branchName] = false;
                ctx.missingBranch[branchName] = true;
                next();
            } else {
                // Avoid deprecation warning by wrapping the error but
                // still allowing cmdln to use `err.code`.
                //   Deprecation: [@octokit/request-error] `error.code` is deprecated, use `error.status`.
                next(
                    new VError(
                        {
                            name: 'GitHubApiError',
                            cause: err,
                            code: err.status,
                            info: {
                                repo: 'joyent/' + repoName
                            }
                        },
                        'error calling GitHub API'
                    )
                );
            }
        });
}

function determineIfChangeRequired(branchName, ctx, next) {
    assert.string(branchName, 'branchName');
    assert.object(ctx.log, 'ctx.log');
    assert.func(next, 'next');

    var log = ctx.log;

    log.trace(
        {protection: ctx.protection[branchName]},
        'determineIfChangeRequired'
    );

    if (ctx.missingBranch[branchName]) {
        ctx.changeRequired[branchName] = false;
        next();
        return;
    }

    ctx.changeRequired[branchName] = false;
    if (ctx.statuses || ctx.unlockUsers) {
        ctx.changeRequired[branchName] = true;
    }
    if (!ctx.protection[branchName]) {
        ctx.changeRequired[branchName] = true;
    } else {
        var pr = ctx.protection[branchName].required_pull_request_reviews;
        if (!pr) {
            ctx.changeRequired[branchName] = true;
        } else {
            if (pr.dismiss_stale_reviews !== true) {
                ctx.changeRequired[branchName] = true;
            } else if (pr.require_code_owner_reviews !== false) {
                ctx.changeRequired[branchName] = true;
            } else if (pr.required_approving_review_count !== 1) {
                ctx.changeRequired[branchName] = true;
            }
        }
        if (ctx.protection[branchName].enforce_admins.enabled !== true) {
            ctx.changeRequired[branchName] = true;
        }
        if (ctx.protection[branchName].restrictions) {
            ctx.changeRequired[branchName] = true;
        }
    }
    log.debug(
        {changeRequired: ctx.changeRequired[branchName]},
        'changeRequired'
    );
    next();
}

function updateBranchProtection(branchName, ctx, next) {
    assert.string(branchName, 'branchName');
    assert.object(ctx.octokit, 'ctx.octokit');
    assert.string(ctx.repoName, 'ctx.repoName');
    assert.func(next, 'next');

    var octokit = ctx.octokit;
    var repoName = ctx.repoName;

    if (!ctx.changeRequired[branchName]) {
        if (!ctx.missingBranch[branchName]) {
            console.log('No update required for ' + branchName + ' branch');
        }
        next();
        return;
    }

    var reqOpts = {};
    var lockMessage = '';

    if (ctx.unlockUsers) {
        lockMessage =
            'Allowing only ' +
            ctx.unlockUsers.join(', ') +
            ' to push to "%s" ' +
            'branch of %s ' +
            '(https://github.com/TritonDataCenter/%s/settings/branches)';
        reqOpts = {
            owner: 'joyent',
            repo: repoName,
            branch: branchName,

            enforce_admins: true,
            required_pull_request_reviews: null,
            restrictions: {
                users: ctx.unlockUsers,
                teams: []
            },
            required_status_checks: null
        };

        if (
            ctx.unlockUsers &&
            ctx.protection[branchName] &&
            ctx.protection[branchName].required_status_checks &&
            ctx.protection[branchName].required_status_checks.contexts &&
            ctx.protection[branchName].required_status_checks.contexts.length >
                0
        ) {
            lockMessage =
                lockMessage +
                '\n' +
                'The following status checks were ' +
                'disabled:\n    ' +
                ctx.protection[branchName].required_status_checks.contexts.join(
                    '\n    '
                );
        }
    } else {
        lockMessage =
            'Applying standard branch protection ' +
            'rules to "%s" branch on repo "%s" ' +
            '(https://github.com/TritonDataCenter/%s/settings/branches)';
        reqOpts = {
            owner: 'joyent',
            repo: repoName,
            branch: branchName,
            enforce_admins: true,
            required_pull_request_reviews: {
                dismissal_restrictions: {},
                dismiss_stale_reviews: true,
                require_code_owner_reviews: false,
                required_approving_review_count: 1
            },
            restrictions: null
        };
        if (ctx.statuses) {
            reqOpts.required_status_checks = {
                contexts: ctx.statuses,
                strict: true
            };
            lockMessage =
                lockMessage +
                '\n' +
                'The following status checks ' +
                'were enabled:\n    ' +
                ctx.statuses.join('    \n');
        } else if (
            ctx.protection[branchName] &&
            ctx.protection[branchName].required_status_checks
        ) {
            reqOpts.required_status_checks =
                ctx.protection[branchName].required_status_checks;
        } else {
            reqOpts.required_status_checks = null;
        }
    }
    octokit.repos
        .updateBranchProtection(reqOpts)
        .then(function(res) {
            console.log(lockMessage, branchName, repoName, repoName);
            next();
        })
        .catch(function(err) {
            // Avoid deprecation warning by wrapping the error but
            // still allowing cmdln to use `err.code`.
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
}

function do_set_branch_protection(subcmd, opts, args, cb) {
    assert.ok(process.env.GITHUB_TOKEN, 'process.env.GITHUB_TOKEN');

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length < 1) {
        cb(new UsageError('missing REPO argument'));
        return;
    } else if (args.length > 1) {
        cb(new UsageError('too many arguments'));
        return;
    }

    if (opts.required_status_checks && opts.unlock) {
        cb(new UsageError('cannot use -s and -U together'));
        return;
    }

    var self = this;
    var jrm = this.top.jrm;
    var log = self.log.child({octokit: true}, true);
    var octokit = Octokit({
        auth: process.env.GITHUB_TOKEN,
        userAgent: 'jr ' + version,
        previews: ['luke-cage'],
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
    var repoName = args[0];

    vasync.pipeline(
        {
            arg: {
                unlockUsers: opts.unlock,
                statuses: opts.required_status_checks
            },
            funcs: [
                function listTheRepos(ctx, next) {
                    jrm.listRepos(
                        {
                            names: [repoName]
                        },
                        function onList(err, repos) {
                            if (err) {
                                next(err);
                                return;
                            }

                            ctx.repos = repos;
                            if (
                                ctx.repos.length === 0 &&
                                jrm.manifestPaths.length === 0
                            ) {
                                self.warnUnconfigured();
                            } else if (ctx.repos.length === 0) {
                                self.top.warn(
                                    'Warning: REPO arg "' +
                                        repoName +
                                        '" did not match a repo'
                                );
                            }
                            next();
                        }
                    );
                },
                function setupContextObjs(ctx, next) {
                    // Create context objects to pass into the
                    // functions which operate on the different
                    // branches.
                    ctx.protection = {};
                    ctx.changeRequired = {};
                    ctx.missingBranch = {};
                    ctx.repoName = repoName;
                    ctx.octokit = octokit;
                    ctx.log = self.log;
                    next();
                },
                // rather than a loop, just operate on each repo in turn
                function getMasterBranchProtection(ctx, next) {
                    getBranchProtection('master', ctx, next);
                },
                function determineIfMasterChangeRequired(ctx, next) {
                    determineIfChangeRequired('master', ctx, next);
                },
                function updateMasterBranchProtection(ctx, next) {
                    updateBranchProtection('master', ctx, next);
                },

                function getMantaV1BranchProtection(ctx, next) {
                    getBranchProtection('mantav1', ctx, next);
                },
                function determineIfMantaV1ChangeRequired(ctx, next) {
                    determineIfChangeRequired('mantav1', ctx, next);
                },
                function updateMantaV1BranchProtection(ctx, next) {
                    updateBranchProtection('mantav1', ctx, next);
                }
            ]
        },
        cb
    );
}

do_set_branch_protection.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['required-status-checks', 's'],
        type: 'arrayOfCommaSepString',
        helpArg: 'STATUSES',
        help:
            'Required status checks which must pass before a PR can be ' +
            'merged. Separate status checks with commas, or use the option ' +
            'multiple times.'
    },
    {
        names: ['unlock', 'U'],
        type: 'arrayOfCommaSepString',
        helpArg: 'USERS',
        help:
            'Remove most branch protection rules, and restrict pushes to the ' +
            'given list of users or teams. Separate users with commas or use ' +
            'the option multiple times.'
    }
];

do_set_branch_protection.helpOpts = {
    helpCol: 20
};

do_set_branch_protection.synopses = ['{{name}} {{cmd}} [OPTIONS] REPO'];

do_set_branch_protection.completionArgtypes = ['jrrepo', 'none'];

do_set_branch_protection.help = [
    'Set branch protection settings for the given repo.',
    '',
    '{{usage}}',
    '',
    '{{options}}',
    '',
    "By default this sets branch protection for the given REPO to Joyent's",
    'standard settings for both the "master" and "mantav1" branches,',
    'if they exist.',
    'The standard settings for branch protection are:',
    '',
    '    [x] Require pull request reviews before merging',
    '',
    '        Required approving reviews: 1',
    '',
    '        [x] Dismiss stale pull request approvals when new commits are pushed',
    '        [ ] Require review from Code Owners',
    '        [ ] Restrict who can dismiss pull request reviews',
    '',
    '    [ ] Require signed commits',
    '',
    '    [x] Include administrators',
    '',
    '    [ ] Restrict who can push to matching branches',
    '',
    'The `-s` option can be used to additionally require given status checks',
    'to pass before allowing PRs to be merged. For example:',
    '    jr gh set-branch-protection -s continuous-integration/jenkins/pr-head,integration-approval REPO',
    '',
    'The `-U` option can be used to "unlock" the branches for direct git',
    'merges. It will:',
    '- remove the requirement that merges come from a PR,',
    '- remove any required status checks for merging (for example those added',
    '  with `-s ...`), and',
    '- restrict who can push to the "master" and "mantav1" branches to the ',
    '  given GitHub users or teams',
    '',
    'For example the following is commonly used to unlock illumos-joyent for',
    'illumos-gate merges:',
    '   jr gh set-branch-protection -U jjelinek illumos-joyent',
    '   # do the merge with git',
    '   jr gh set-branch-protection -s integration-approval illumos-joyent'
].join('\n');

module.exports = do_set_branch_protection;
