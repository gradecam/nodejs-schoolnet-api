"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var url = require("url");
var moment = require("moment");
var _ = require("lodash");
var log4js = require("log4js");
var P = require("bluebird");
var log = log4js.getLogger("schoolnet");
var rest = require("@gradecam/restler-q"); // tslint:disable-line
// This shouldn't be necessary as it should be the default form log4js but it isn't.
log.setLevel("INFO");
var DEFAULTS = {
    limit: 500,
    offset: 0,
};
var MAX_RETRIES = 3;
var SchoolnetApi = /** @class */ (function () {
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
        for (var _i = 0, _a = Object.keys(creds); _i < _a.length; _i++) {
            var key = _a[_i];
            if (creds[key]) {
                continue;
            }
            delete creds[key];
        }
        this.oauthCreds = creds;
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
            return self.apiPut(url, obj)
                .then(function () { return _.extend({ success: true }, obj); }, function (err, response) {
                if (err && err.stack) {
                    log.error("putStudentAssessment:", response, err.stack);
                }
                log.warn("putStudentAssessment:", JSON.stringify({
                    body: studentAssessment,
                    error: err,
                    response: response,
                }));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2Nob29sbmV0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3NjaG9vbG5ldC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHlCQUEyQjtBQUMzQiwrQkFBaUM7QUFDakMsMEJBQTRCO0FBQzVCLCtCQUFpQztBQUNqQyw0QkFBOEI7QUFFOUIsSUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUMxQyxJQUFNLElBQUksR0FBUSxPQUFPLENBQUMscUJBQXFCLENBQUMsQ0FBQyxDQUFDLHNCQUFzQjtBQUV4RSxvRkFBb0Y7QUFDcEYsR0FBRyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUVyQixJQUFJLFFBQVEsR0FBRztJQUNYLEtBQUssRUFBRSxHQUFHO0lBQ1YsTUFBTSxFQUFFLENBQUM7Q0FDWixDQUFDO0FBRUYsSUFBSSxXQUFXLEdBQUcsQ0FBQyxDQUFDO0FBRXBCO0lBUUksc0JBQVksTUFBVztRQUNuQixNQUFNLEdBQUcsTUFBTSxJQUFJLEVBQUUsQ0FBQztRQUN0QixJQUFJLEtBQUssR0FBcUI7WUFDMUIsU0FBUyxFQUFFLE1BQU0sQ0FBQyxRQUFRLElBQUksTUFBTSxDQUFDLFNBQVM7WUFDOUMsYUFBYSxFQUFFLE1BQU0sQ0FBQyxZQUFZLElBQUksTUFBTSxDQUFDLGFBQWE7WUFDMUQsVUFBVSxFQUFFLG9CQUFvQjtZQUNoQyxLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUssSUFBSSxzQkFBc0IsR0FBRyxNQUFNLENBQUMsS0FBSztTQUMvRCxDQUFDO1FBQ0YsSUFBSSxPQUFPLEdBQUcsTUFBTSxDQUFDLE9BQU8sSUFBSSxNQUFNLENBQUMsR0FBRyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUM7UUFDN0QsSUFBSSxDQUFDLE9BQU8sR0FBRyxHQUFHLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxVQUFVLENBQUMsQ0FBQztRQUNoRCxJQUFJLENBQUMsUUFBUSxHQUFH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