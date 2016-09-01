"use strict";
var url = require("url");
var moment = require("moment");
var _ = require("lodash");
var log4js = require("log4js");
var P = require("bluebird");
var log = log4js.getLogger("schoolnet");
var rest = require("restler-q"); // tslint:disable-line
// This shouldn't be necessary as it should be the default form log4js but it isn't.
log.setLevel("INFO");
var DEFAULTS = {
    limit: 500,
    offset: 0,
};
var MAX_RETRIES = 3;
var SchoolnetApi = (function () {
    function SchoolnetApi(config) {
        config = config || {};
        var creds = {
            client_id: config.clientId || config.client_id,
            client_secret: config.clientSecret || config.client_secret,
            grant_type: "client_credentials",
            scope: config.scope && "default_tenant_path:" + config.scope
        };
        var baseUrl = config.baseUrl || config.url || config.baseURL;
        this.baseURL = url.resolve(baseUrl, "/api/v1/");
        this.tokenUrl = url.resolve(baseUrl, "/api/oauth/token");
        this.token = void (0);
        this.expires = 0;
        this.omissions = ["links", "institutionType"];
        this.oauthCreds = _.omit(creds, _.isEmpty);
    }
    return SchoolnetApi;
}());
exports.SchoolnetApi = SchoolnetApi;
// let BACKOFF = [3000, 1000, 500];
var BACKOFF = [5 * 60 * 1000, 60 * 1000, 3 * 1000];
function backoff(idx) {
    var timeout = BACKOFF[idx];
    var dfd = P.defer();
    log.info("Retrying request after:", timeout);
    setTimeout(function () {
        dfd.resolve(timeout);
    }, timeout);
    return dfd.promise;
}
var RETRY_CODES = ["ETIMEDOUT", "ECONNRESET"];
rest.service(SchoolnetApi, {}, {
    _requestToken: function _requestToken(creds, attemptsRemaining) {
        log.info("Requesting access token...");
        var self = this;
        return rest.post(self.tokenUrl, { data: creds }).then(function (data) {
            if (_.isEmpty(data.access_token)) {
                var err = new Error("Failed to obtain token.");
                err.body = data;
                return P.reject(err);
            }
            return P.resolve({ access_token: data.access_token, expires: data.expires_in });
        }, function (err) {
            if (attemptsRemaining) {
                attemptsRemaining--;
                return backoff(attemptsRemaining).then(function () {
                    return self._requestToken(creds, attemptsRemaining);
                });
            }
        });
    },
    accessToken: function accessToken(creds) {
        var self = this;
        var start = Date.now();
        if (self.expires <= start) {
            return self._requestToken(creds, 3).then(function (data) {
                self.token = data.access_token;
                self.expires = (start + data.expires * 1000) - 10000;
                log.info("token obtained in: %dms expires: %d", Date.now() - start, self.expires);
                return self.token;
            });
        }
        else {
            log.debug("Using existing token.");
            return P.resolve(self.token);
        }
    },
    _get: function _get(uri, options, attemptsRemaining) {
        var self = this;
        return self.get(uri, options).fail(function (err) {
            var retryCode = _.includes(RETRY_CODES, err.code);
            log.error("Request failed with error:", err);
            if (!(retryCode && attemptsRemaining)) {
                return P.reject(err);
            }
            attemptsRemaining--;
            return backoff(attemptsRemaining).then(function () {
                return self._get(uri, options, attemptsRemaining);
            });
        });
    },
    apiGet: function apiGet(path, options, recursive) {
        var self = this;
        options = _.extend({ query: {} }, options || {});
        log.debug("apiGet:", { path: path, options: options, recursive: recursive });
        if (recursive === void (0)) {
            if (options.limit || options.offset >= 0) {
                log.debug("limit or offset provided");
                recursive = options.recursive;
                options.query.limit = options.limit || DEFAULTS.limit;
                options.query.offset = options.offset || DEFAULTS.offset;
                delete options.limit;
                delete options.offset;
                delete options.recursive;
            }
            else {
                log.debug("neither limit nor offset provided");
                recursive = true;
                options.query.limit = DEFAULTS.limit;
                options.query.offset = DEFAULTS.offset;
            }
        }
        return self.accessToken(self.oauthCreds).then(function (token) {
            var opts = _.extend({}, options, { accessToken: token });
            log.debug("requesting:", { path: path, opts: opts });
            return self._get(path, opts, MAX_RETRIES).then(function (data) {
                data = data.data || {};
                if (_.isArray(data)) {
                    data = data.map(function (obj) { return self.trimObj(obj, self.omissions); });
                }
                else {
                    data = self.trimObj(data, self.omissions);
                }
                return data;
            });
        }).then(function (data) {
            if (!recursive || !_.isArray(data) || data.length < options.query.limit) {
                return data;
            }
            var limit = options.query.limit;
            var offset = options.query.offset += limit;
            log.debug("requesting next page", { limit: limit, offset: offset, options: options });
            return P.resolve(self.apiGet(path, options, recursive)).then(function (results) {
                _.each(results, function (result) {
                    data.push(result);
                });
                return data;
            });
        });
    },
    apiPut: function apiPut(path, payload, options) {
        var self = this;
        return self.accessToken(self.oauthCreds).then(function (token) {
            var opts = _.extend({}, options || {}, { accessToken: token });
            log.debug("putting:", { path: path, opts: opts });
            return self.putJson(path, payload, opts).then(function (data) {
                data = data.data || {};
                if (_.isArray(data)) {
                    data = data.map(function (obj) { return self.trimObj(obj, self.omissions); });
                }
                else {
                    data = self.trimObj(data, self.omissions);
                }
                return data;
            });
        });
    },
    trimObj: function trimObj(obj, omissions) {
        obj = _.omit(obj, omissions);
        return obj;
    },
    /**
     * Retrieve list of Assessments
     *
     * @param opts object the options to use when retrieving the list of assessments.
     *                       default options: {limit: 100, offset: 0}
     */
    getAssessments: function getAssessments(optsAny) {
        if (optsAny === void 0) { optsAny = null; }
        var self = this;
        return P.resolve(optsAny).then(function (opts) {
            opts = opts || {};
            var options = {
                query: {
                    filter: "teststage==\"scheduled inprogress completed\";itemtype==MultipleChoice,itemtype==TrueFalse",
                },
            };
            if (opts.modifiedsince) {
                var date = moment(opts.modifiedsince).format("MM-DD-YYYY");
                options.query.filter = "modifiedsince==" + date + ";" + options.query.filter;
            }
            options = _.extend(options, _.pick(opts, "limit", "offset"));
            return self.apiGet("assessments", options).then(function (alist) {
                return (alist || []).filter(function (x) { return x.instanceId; });
            });
        });
    },
    getAssessment: function getAssessment(objOrId) {
        var self = this;
        return P.resolve(objOrId).then(function (assessmentOrId) {
            var opts = {
                query: {
                    expand: "assessmentquestion,assessmentschedule",
                }
            };
            var assessmentOrIdAny = assessmentOrId;
            var id = assessmentOrIdAny.id || assessmentOrIdAny.instanceId || assessmentOrIdAny;
            return self.apiGet("assessments/" + id, opts);
        });
    },
    getDistricts: function getDistricts() {
        return this.apiGet("districts");
    },
    getSchool: function getSchool(obj, optsAny) {
        if (optsAny === void 0) { optsAny = null; }
        var self = this;
        return P.all([obj, optsAny]).then(function (args) {
            var school = args[0];
            var opts = args[1];
            var schoolId = school.id || school.institutionId || school;
            opts = opts || {};
            return self.apiGet("schools/" + schoolId, opts);
        });
    },
    getSchools: function getSchools(districtAny, optsAny) {
        if (optsAny === void 0) { optsAny = null; }
        var self = this;
        return P.all([districtAny, optsAny]).then(function (args) {
            var district = args[0];
            var opts = args[1];
            var districtId = district.id || district.institutionId || district;
            return self.apiGet("districts/" + districtId + "/schools", opts);
        });
    },
    getSection: function getSection(obj) {
        var self = this;
        return P.resolve(obj).then(function (section) {
            var sectionId = section.id || section.sectionId || section;
            var opts = { query: { expand: "assessmentassignment,course,schedule" } };
            return self.apiGet("sections/" + sectionId, opts);
        });
    },
    getSections: function getSections(obj, optsAny) {
        if (optsAny === void 0) { optsAny = null; }
        var self = this;
        return P.all([obj, optsAny]).then(function (args) {
            var school = args[0];
            var opts = args[1];
            var schoolId = school.id || school.institutionId || school;
            return self.apiGet("schools/" + schoolId + "/sections", opts);
        });
    },
    getStudents: function getStudents(obj, optsAny) {
        if (optsAny === void 0) { optsAny = null; }
        var self = this;
        return P.all([obj, optsAny]).then(function (args) {
            var section = args[0];
            var opts = args[1];
            var sectionId = section.id || section.sectionId || section;
            opts = _.extend(opts || {}, { query: { expand: "identifier" } });
            return self.apiGet("sections/" + sectionId + "/students", opts);
        });
    },
    putStudentAssessment: function putStudentAssessment(studentAssessment) {
        var self = this;
        return P.resolve(studentAssessment).then(function (obj) {
            if (!obj || !obj.assessmentId) {
                log.error("putStudentAssessment: Invalid asssessment: ", obj);
                return { success: false };
            }
            var url = "assessments/" + obj.assessmentId + "/studentAssessments";
            return self.apiPut(url, obj).then(function () { return _.extend({ success: true }, obj); }, function (err, response) {
                if (err && err.stack) {
                    log.error("putStudentAssessment:", response, err.stack);
                }
                else {
                    log.warn("putStudentAssessment:", err, response);
                }
                return _.extend({ success: false }, obj, err);
            });
        });
    },
    getStaff: function getStaff(obj, opts) {
        if (opts === void 0) { opts = null; }
        var self = this;
        return P.all([obj, opts]).spread(function (objAny, optsAny) {
            var staffId = objAny.staffId || objAny.teacher || objAny.id || objAny;
            opts = _.extend(optsAny || {}, { query: { expand: "identifier" } });
            return self.apiGet("staff/" + staffId, opts);
        });
    },
    getStaffSections: function getStaffSections(obj) {
        var self = this;
        return P.resolve(obj).then(function (objAny) {
            var staffId = objAny.staffId || objAny.teacher || objAny.id || objAny;
            return self.apiGet("staff/" + staffId + "/staffSectionAssignments");
        });
    },
    getTenants: function getTenants() {
        var self = this;
        return self.get("tenants").then(function (data) {
            return data.data.map(function (x) { return self.trimObj(x, self.omissions); });
        });
    },
    setLogLevel: function setLogLevel(level) {
        log.setLevel(level);
    },
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2Nob29sbmV0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3NjaG9vbG5ldC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEsSUFBWSxHQUFHLFdBQU0sS0FBSyxDQUFDLENBQUE7QUFDM0IsSUFBWSxNQUFNLFdBQU0sUUFBUSxDQUFDLENBQUE7QUFDakMsSUFBWSxDQUFDLFdBQU0sUUFBUSxDQUFDLENBQUE7QUFDNUIsSUFBWSxNQUFNLFdBQU0sUUFBUSxDQUFDLENBQUE7QUFDakMsSUFBWSxDQUFDLFdBQU0sVUFBVSxDQUFDLENBQUE7QUFFOUIsSUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUMxQyxJQUFNLElBQUksR0FBUSxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxzQkFBc0I7QUFFOUQsb0ZBQW9GO0FBQ3BGLEdBQUcsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7QUFFckIsSUFBSSxRQUFRLEdBQUc7SUFDWCxLQUFLLEVBQUUsR0FBRztJQUNWLE1BQU0sRUFBRSxDQUFDO0NBQ1osQ0FBQztBQUVGLElBQUksV0FBVyxHQUFHLENBQUMsQ0FBQztBQUVwQjtJQVFJLHNCQUFZLE1BQVc7UUFDbkIsTUFBTSxHQUFHLE1BQU0sSUFBSSxFQUFFLENBQUM7UUFDdEIsSUFBSSxLQUFLLEdBQXFCO1lBQzFCLFNBQVMsRUFBRSxNQUFNLENBQUMsUUFBUSxJQUFJLE1BQU0sQ0FBQyxTQUFTO1lBQzlDLGFBQWEsRUFBRSxNQUFNLENBQUMsWUFBWSxJQUFJLE1BQU0sQ0FBQyxhQUFhO1lBQzFELFVBQVUsRUFBRSxvQkFBb0I7WUFDaEMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxLQUFLLElBQUksc0JBQXNCLEdBQUcsTUFBTSxDQUFDLEtBQUs7U0FDL0QsQ0FBQztRQUNGLElBQUksT0FBTyxHQUFHLE1BQU0sQ0FBQyxPQUFPLElBQUksTUFBTSxDQUFDLEdBQUcsSUFBSSxNQUFN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