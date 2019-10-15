/*
 * Copyright 2019 Joyent, Inc.
 *
 * The `jr github-settings ...` CLI class.
 */

var Cmdln = require('cmdln').Cmdln;
var util = require('util');



// ---- CLI class

function GitHubSettingsCli(top) {
    this.top = top;
    Cmdln.call(this, {
        name: top.name + ' github-settings',
        desc: [
            'Check and manage GitHub repository settings.'
        ].join('\n'),
        helpOpts: {
            minHelpCol: 24 // line up with option help
        },
        helpSubcmds: [
            'help',
            'check',
        ]
    });
}
util.inherits(GitHubSettingsCli, Cmdln);

GitHubSettingsCli.prototype.init = function init(opts, args, cb) {
    this.log = this.top.log;
    Cmdln.prototype.init.apply(this, arguments);
};

GitHubSettingsCli.prototype.do_check = require('./do_check');


GitHubSettingsCli.aliases = ['gh'];

module.exports = GitHubSettingsCli;