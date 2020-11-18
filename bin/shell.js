#!/usr/bin/env node
/* jshint node:true, unused:true */
'use strict';

var fs = require('fs');

var log4js = require('log4js');
var rest   = require('@gradecam/restler-q');

var Api = require('../dist/schoolnet');

var log = log4js.getLogger('schoolnet');

function embedShell(config) {
    var doc = ['Schoolnet interactive shell\n',
    'Current config:\n' + JSON.stringify(config, null, 2) + '\n',
    'The following variables are in your context:',
    '  api - SchoolnetApi service instance',
    '  config',
    '  log - log4js logger (schoolnet)',
    '  Api - Schoolnet service constructor\n',
    '  modules:',
    '    log4js, rest (restler-q)\n',
    ];
    var context = {
        api: config && new Api(config),
        Api: Api,
        config: config,
        log: log,
        log4js: log4js,
        rest: rest,
    };
    require('embed-shell')({context: context, doc: doc, prompt: 'schoolnet> '});
}

function loadConfig(filename) {
    if (!filename) {
        return null;
    }
    if (filename[0] != '/') {
        filename = process.cwd() + '/' + filename;
    }
    if (!fs.existsSync(filename)) {
        return null;
    }
    return require(filename);
}

function main() {
    var prog = require('commander');
    prog.option('-c, --config [config]', 'json conf file');
    prog.parse(process.argv);
    embedShell(loadConfig(prog.config));
}

if (!module.parent) {
    main();
}
