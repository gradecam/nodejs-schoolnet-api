/* jshint node:true, unused:true */
'use strict';

var url = require('url');

var _ = require('lodash'),
    Q = require('q'),
    log = require('log4js').getLogger('schoolnet'),
    moment = require('moment'),
    rest = require('restler-q');

// This shouldn't be necessary as it should be the default form log4js but it isn't.
log.setLevel('WARN');

var DEFAULTS = {
    limit: 500,
    offset: 0,
};

var MAX_RETRIES = 4;

function SchoolnetApi(config) {
    config = config || {};
    var creds = {
        client_id: config.clientId || config.client_id,
        client_secret: config.clientSecret || config.client_secret,
        grant_type: 'client_credentials',
        scope: config.scope && 'default_tenant_path:' + config.scope
    };
    var baseUrl = url.parse(config.baseUrl || config.url || config.baseURL);
    this.baseURL = baseUrl.resolve('/api/v1/');
    this.tokenUrl = baseUrl.resolve('/api/oauth/token');
    this.token = void(0);
    this.expires = Date.now();
    this.omissions = ['links', 'institutionType'];
    this.oauthCreds = _.omit(creds, _.isEmpty);
}

var AUG = 7;

function schoolYearStart(date) {
    if (date) {
        date = moment(date);
    } else {
        date = moment();
        if (date.month() >= AUG) {
            date = moment(date.year() + '-08-01');
        } else {
            date = moment((date.year() - 1) + '-08-01');
        }
    }
    return date.format('MM-DD-YYYY');
}

function schoolYearEnd(date) {
    if (date) {
        date = moment(date);
    } else {
        date = moment();
        if (date.month() >= AUG) {
            date = moment((date.year() + 1) + '-07-31');
        } else {
            date = moment(date.year() + '-07-31');
        }
    }
    return date.format('MM-DD-YYYY');
}

// var BACKOFF = [3000, 1000, 500];
var BACKOFF = [5 * 60 * 1000, 60 * 1000, 3 * 1000];

function backoff(idx) {
    var timeout = BACKOFF[idx];
    var dfd = Q.defer();
    setTimeout(function() {
        dfd.resolve(timeout);
    }, timeout);
    return dfd.promise;
}

var RETRY_CODES = ['ETIMEDOUT', 'ECONNRESET'];


module.exports = rest.service(SchoolnetApi, {}, {
    accessToken: function(creds) {
        var dfd = Q.defer();
        var self = this;
        var now = Date.now();
        if (self.expires < now) {
            log.debug('Obtain new token.');
            rest.post(self.tokenUrl, {data: creds}).then(function(data) {
                self.token = data.access_token;
                self.expires = now + data.expires_in * 1000;
                dfd.resolve(self.token);
            });
        } else {
            dfd.resolve(self.token);
        }
        return dfd.promise;
    },
    _get: function _get(uri, options, retries) {
        var dfd = Q.defer();
        var self = this;
        var result = self.get(uri, options);
        result.then(function(data) {
            dfd.resolve(data);
        }, function(err) {
            var retryCode = _.indexOf(RETRY_CODES, err.code) !== -1;
            if (!(retryCode && retries)) {
                dfd.reject(err);
                return;
            }
            retries--;
            backoff(retries).then(function() {
                dfd.resolve(self._get(uri, options, retries));
            });
        });
        return dfd.promise;
    },
    apiGet: function(path, options, recursive) {
        var self = this;
        options = _.extend({query: {}}, options || {});
        log.info('apiGet:', {path: path, options: options, recursive: recursive});
        if (recursive === void(0)) {
            if (options.limit || options.offset >= 0) {
                log.debug('limit or offset provided');
                recursive = options.recursive;
                options.query.limit = options.limit || DEFAULTS.limit;
                options.query.offset = options.offset || DEFAULTS.offset;
                delete options.limit;
                delete options.offset;
                delete options.recursive;
            } else {
                log.debug('neither limit nor offset provided');
                recursive = true;
                options.query.limit = DEFAULTS.limit;
                options.query.offset = DEFAULTS.offset;
            }
        }
        return self.accessToken(self.oauthCreds).then(function(token) {
            var opts = _.extend({}, options, {accessToken: token});
            log.info('requesting:', {path: path, opts: opts});
            return self._get(path, opts, MAX_RETRIES).then(function(data) {
                data = data.data || {};
                if (_.isArray(data)) {
                    data = _.map(data, function(obj) {
                        return self.trimObj(obj, self.omissions);
                    });
                } else {
                    data = self.trimObj(data, self.omissions);
                }
                return data;
            });
        }).then(function(data) {
            if (!recursive || !_.isArray(data) || data.length < options.query.limit) {
                return data;
            }
            var limit = options.query.limit;
            var offset = options.query.offset += limit;
            log.info('requesting next page', {limit: limit, offset: offset, options: options});
            return Q.when(self.apiGet(path, options, recursive)).then(function(results) {
                _.each(results, function(result) {
                    data.push(result);
                });
                return data;
            });
        });
    },
    apiPut: function(path, payload, options) {
        var self = this;
        return self.accessToken(self.oauthCreds).then(function(token) {
            var opts = _.extend({}, options || {}, {accessToken: token});
            log.debug('putting:', {path: path, opts: opts});
            return self.putJson(path, payload, opts).then(function(data) {
                data = data.data || {};
                if (_.isArray(data)) {
                    data = _.map(data, function(obj) {
                        return self.trimObj(obj, self.omissions);
                    });
                } else {
                    data = self.trimObj(data, self.omissions);
                }
                return data;
            });
       });
    },
    trimObj: function(obj, omissions) {
        obj = _.omit(obj, omissions);
        return obj;
    },
    /**
     * Retrieve list of Assessments
     *
     * @param opts object the options to use when retrieving the list of assessments.
     *                       default options: {limit: 100, offset: 0}
     **/
    getAssessments: function(opts) {
        var self = this;
        return Q.when(opts).then(function(opts) {
            opts = opts || {};
            var options = {
                query: {
                    startDate: schoolYearStart(opts.startDate),
                    endDate: schoolYearEnd(opts.endDate),
                    filter: "teststage=='scheduled inprogress completed';itemtype==MultipleChoice,itemtype==TrueFalse",
                },
            };
            if (opts.modifiedsince) {
                var date = moment(opts.modifiedsince).format('MM-DD-YYYY');
                options.query.filter = 'modifiedsince==' + date + ';' + options.query.filter;
            }
            options = _.extend(options, _.pick(opts, 'limit', 'offset'));
            return self.apiGet('assessments', options).then(function(alist) {
                return _.filter(alist, function(x) {
                    return x.instanceId;
                });
            });
        });
    },
    getAssessment: function(ament) {
        var self = this;
        return Q.when(ament).then(function(ament) {
            var opts = {
                query: {
                    expand: 'assessmentquestion',
                }
            };
            ament = ament.id || ament.instanceId || ament.masterId || ament;
            return self.apiGet('assessments/' + ament, opts);
        });
    },
    getDistricts: function() {
        return this.apiGet('districts');
    },
    getSchool: function(school, opts) {
        var self = this;
        return Q.all([school, opts]).then(function(args) {
            var school = args[0];
            var opts = args[1];
            var schoolId = school.id || school.institutionId || school;
            opts = opts || {};
            return self.apiGet('schools/' + schoolId, opts);
        });
    },
    getSchools: function(district, opts) {
        var self = this;
        return Q.all([district, opts]).then(function(args) {
            var district = args[0];
            var opts = args[1];
            var district_id = district.id || district.institutionId || district;
            return self.apiGet('districts/' + district_id + '/schools', opts);
        });
    },
    getSection: function(section) {
        var self = this;
        return Q.when(section).then(function(section) {
            var sectionId = section.id || section.sectionId || section;
            var opts = {query: {expand: 'assessmentassignment'}};
            return self.apiGet('sections/' + sectionId, opts);
        });
    },
    getSections: function(school, opts) {
        var self = this;
        return Q.all([school, opts]).then(function(args) {
            var school = args[0];
            var opts = args[1];
            var schoolId = school.id || school.institutionId || school;
            return self.apiGet('schools/' + schoolId + '/sections', opts);
        });
    },
    getStudents: function(section, opts) {
        var self = this;
        return Q.all([section, opts]).then(function(args) {
            var section = args[0];
            var opts = args[1];
            var sectionId = section.id || section.sectionId || section;
            opts = _.extend(opts || {}, {query: {expand: 'identifier'}});
            return self.apiGet('sections/' + sectionId + '/students', opts);
        });
    },
    putStudentAssessment: function(obj) {
        var self = this;
        return Q.when(obj).then(function(obj) {
            var url = 'assessments/' + obj.assessmentId + '/studentAssessments';
            return self.apiPut(url, obj).then(function() {
                return _.extend({success: true}, obj);
            }, function(err, response) {
                var dfd = Q.defer();
                if (err && err.stack) {
                    log.error('putStudentAssessment:', response, err.stack);
                } else {
                    log.warn('putStudentAssessment:', err, response);
                }
                dfd.resolve(_.extend({success: false}, obj, err));
                return dfd.promise;
            });
        });
    },
    getStaff: function(obj, opts) {
        var self = this;
        return Q.all([obj, opts]).then(function(args) {
            var obj = args[0];
            var opts = args[1];
            var staffId = obj.staffId || obj.teacher || obj.id || obj;
            opts = _.extend(opts || {}, {query: {expand: 'identifier'}});
            return self.apiGet('staff/' + staffId, opts);
        });
    },
    getStaffSections: function(obj) {
        var self = this;
        return Q.when(obj).then(function(obj) {
            var staff_id = obj.staffId || obj.teacher || obj.id || obj;
            return self.apiGet('staff/' + staff_id + '/staffSectionAssignments');
        });
    },
    getTenants: function() {
        var self = this;
        return self.get('tenants').then(function(data) {
            return _.map(data.data, function(data) {
                return self.trimObj(data, self.omissions);
            });
        });
    },
    setLogLevel: function(level) {
        log.setLevel(level);
    },
});
