/*
    Copyright (c) 2015 Unify Inc.

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the "Software"),
    to deal in the Software without restriction, including without limitation
    the rights to use, copy, modify, merge, publish, distribute, sublicense,
    and/or sell copies of the Software, and to permit persons to whom the Software
    is furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
    OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
    IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
    CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
    TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
    OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

/*jshint node:true, esversion:6 */
/*global require, Promise */

'use strict';

// Load configuration
let config = require('./config.json');

// Load Bunyan logger
let bunyan = require('bunyan');

// SDK logger
let sdkLogger = bunyan.createLogger({
    name: 'sdk',
    stream: process.stdout,
    level: config.sdkLogLevel
});

// Application logger
let logger = bunyan.createLogger({
    name: 'app',
    stream: process.stdout,
    level: 'debug'
});

// Node utils
let assert = require('assert');

// Circuit SDK
let Circuit = require('circuit');

// REST Client
let RestClient = new require('node-rest-client').Client;

// Markdown to HTML converter
let marked = require('marked');

// Setup bunyan logger
Circuit.setLogger(sdkLogger);

// Allow REST calls without a certificate
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

// Application variables
let jiraClient = new RestClient();
let jiraCookie;
let client;
let issues = new Map();

//*********************************************************************
//* Issue Class
//*********************************************************************
class Issue {
  constructor(issue) {
    this.key = issue.key;
    this.summary = issue.fields.summary;
    this.description = issue.fields.description;
    this.assignee = issue.fields.assignee ? issue.fields.assignee.displayName : '';
    this.reporter = issue.fields.reporter ? issue.fields.reporter.displayName : '';
    this.status = issue.fields.status.name;
    this.priority = issue.fields.priority.name;
    this.labels = issue.fields.labels ? issue.fields.labels : [];
    this.affectedVersion = (issue.fields.versions && issue.fields.versions.length) ? issue.fields.versions[0].name : '';
  }
  
  toSummary() {
    return `${this.key}: ${this.summary}`;
  }
}

//*********************************************************************
//* Helper functions
//*********************************************************************
function terminate(err) {
    logger.error('Unrecoverable error. Aborting due to ' + error.message);
    process.exit(1);
}

function done() {
    logger.info('Done. Press Ctrl-C to exit');
}

function truncate(value, length, escape) {
    let val = value.substring(0, length);
    if (value.length > length) {
        val += '...';
    }
    escape && (val = Circuit.Utils.textToHtmlEscaped(val));
    return val;
}
//*********************************************************************
// init
//*********************************************************************
function init() {
    // Not yet used
    return Promise.resolve();
}

//*********************************************************************
// logonCircuit
//*********************************************************************
function logonCircuit() {
    client = new Circuit.Client({domain: config.circuit.domain});
    return client.logon(config.circuit.email, config.circuit.password, {mobile: true})
        .then((user) => logger.info(`Logged on to ${config.circuit.domain} as ${user.emailAddress}`));
}

//*********************************************************************
// logonJira
//*********************************************************************
function logonJira() {
    return new Promise((resolve, reject) => {
        let url = config.jira.domain + '/rest/auth/1/session';
        let args = {
            data: {
                username: config.jira.username,
                password: config.jira.password
            },
            headers: {
                'Content-Type': 'application/json'
            } 
        };

        logger.debug(`Login request to JIRA as ${args.data.username} on ${url}`);

        jiraClient.post(url, args, (data, response) => {
            if (response.statusCode === 200) {
                jiraCookie = data.session.name + '=' + data.session.value;
                logger.info(`Succesfully logged in to Jira. cookie: ${jiraCookie}`);
                resolve();
            } else {
                logger.error(`Error loging in to Jira at ${url} as ${config.jira.username}`);
                jiraCookie = null;
                reject(response.statusCode);
            }
        }); 
    });
}

//*********************************************************************
// execJiraRequest
//*********************************************************************
function execJiraRequest(path, params) {
    //E.g. path = 'search', params = {jql: 'type=Bug AND status=Closed'};
    return new Promise((resolve, reject) => {
        let url = config.jira.domain + '/rest/api/2/' + path;
            
        let args = {
            headers: {
                cookie: jiraCookie,
                'Content-Type': 'application/json'
            },
            data: params 
        };

        logger.debug(`Query JIRA: url: ${url}, args: ${JSON.stringify(args)}`);
        
        let req = jiraClient.post(url, args, (data, response) => {
            if (response.statusCode === 200) {
                resolve(data);
            } else if (response.statusCode === 401) {
                logger.info('401 Unauthorized. Trying to re-authorize.');
                logonJira().then(() => {
                    logger.info('Successfully re-authorized.');
                }).catch(e => {
                    logger.error('Failed to re-authorize. Giving up. ', e);
                    reject(e);
                });
            } else {
                logger.error(response.statusCode + ' ' + response.statusMessage);
                reject(response.statusCode);
            }
        });
        
        req.on('requestTimeout', req => {
            req.abort();
            reject('Jira request has expired');
        });
        
        req.on('responseTimeout', res => {
            reject('Jira response has expired');
        });
        
        req.on('error', err => {
            reject('Jira request failed: ' + err);
        });
    });
}

//*********************************************************************
// buildContent
//*********************************************************************
function buildContent(issue) {
    let description = truncate(marked(issue.description), 400, false);

    return `Version: <b>${issue.affectedVersion}</b><br>` +
        `Priority: <b>${issue.priority}</b><br>` +
        `Reporter: <b>${issue.reporter}</b><br>` +
        `Assignee: <b>${issue.assignee}</b><br>` +
        `Labels: <b>${issue.labels.join(', ')}</b><br>` +
        `<a href="${config.jira.internalDomain}/browse/${issue.key}">${issue.key}</a>&nbsp;(<a href="${config.jira.domain}/browse/${issue.key}">public url</a>)<br>` +
        `----------<br>` +
        `${description}`;
}

//*********************************************************************
// postIssues
//*********************************************************************
function postIssues(issues) {
    let tasks = [];

    issues.forEach(issue => {
        logger.info('Posting ' + issue.key);
        let msg = {
            subject: truncate(issue.summary, 100),
            content: buildContent(issue),
            contentType: Circuit.Constants.TextItemContentType.RICH
        };
        tasks.push(client.addTextItem(config.circuit.convId, msg));            
    });

    return Promise.all(tasks);
}

//*********************************************************************
// fetchIssues
//*********************************************************************
function fetchIssues() {
    return new Promise((resolve, reject) => {
        execJiraRequest('search', config.jira.issuesPoll.query).then(data => {
            let result = [];
            data.issues && data.issues.forEach(i => {
                if (!issues.has(i.key)) {
                    let issue = new Issue(i);
                    // Cache issue to find it later when replying to it
                    issues.set(i.key, issue);
                    // Add to results array
                    result.push(issue);
                    
                    logger.debug(`Fetched JIRA issue: ${i.key}`);
                } else {
                    logger.debug(`JIRA issue ${i.key} already in cache. Skip it.`);
                }
            });
            logger.info(`Fetched ${data.issues ? data.issues.length: 0} JIRA issues`);
            resolve(result);
        }).catch(e => reject(e));
    });
}

//*********************************************************************
// fetchDailyReport
//*********************************************************************
function fetchDailyReport() {
    return new Promise((resolve, reject) => {
        execJiraRequest('search', config.jira.reportPoll.query).then(data => {
            let result = [];
            data.issues && data.issues.forEach(i => result.push(new Issue(i)));
            logger.info(`Fetched ${data.issues ? data.issues.length: 0} JIRA issues for report.`);
            resolve(result);
        }).catch(e => reject(e));
    });
}

//*********************************************************************
// sortDailyReport
//*********************************************************************
function sortDailyReport(issues) {
    // Sort issues into P0 and P1
    let result = {
        P0: issues.filter(i => i.priority === 'P0'),
        P1: issues.filter(i => i.priority === 'P1')
    };

    // P0s need to be sorted by affectedVersion. jql doesn't seem to do that.
    result.P0.sort((a, b) => {
        return a.affectedVersion.localeCompare(b.affectedVersion);
    });

    return Promise.resolve(result);
}

//*********************************************************************
// postDailyReport
//*********************************************************************
function postDailyReport(issuesObj) {
    function buildIssueContent(issue) {
        let result;
        let summary = truncate(issue.summary, 78);
        return `<a href="${config.jira.internalDomain}/browse/${issue.key}">${issue.key}</a>&nbsp;(<a href="${config.jira.domain}/browse/${issue.key}">p</a>)` +
            (issue.assignee ? ` with <b>${issue.assignee}</b>` : ` unassigned`) + `<br>` +
            `${summary}<br>`; 
    }

    logger.info(`Posting report with ${issuesObj.P0.length} P0 and ${issuesObj.P1.length} P1 issues`);

    let msg = {
        subject: config.jira.reportPoll.name,
        content: '',
        contentType: Circuit.Constants.TextItemContentType.RICH
    };
    
    msg.content = msg.content.concat(`<b>${issuesObj.P0.length} P0's</b> and <b>${issuesObj.P1.length} P1's</b><br>`);
    
    let prevIssue;
    issuesObj.P0.forEach(issue => {
        if (!prevIssue || prevIssue.affectedVersion !== issue.affectedVersion) {
            if (issue.affectedVersion) {
                msg.content = msg.content.concat(`<br><span class="rich-text-highlight">P0 for version ${issue.affectedVersion}:</span><br>`);
            } else {
                msg.content = msg.content.concat(`<br><span class="rich-text-highlight">P0 for unassigned version:</span><br>`);
            }
        }
        msg.content = msg.content.concat(buildIssueContent(issue));
        prevIssue = issue;
    });

    msg.content = msg.content.concat(`<br><span class="rich-text-highlight">P1:</span><br>`);
    issuesObj.P1.forEach(issue => {
        msg.content = msg.content.concat(buildIssueContent(issue));
    });

    return client.addTextItem(config.circuit.convId, msg);
}

//*********************************************************************
// runDailyReport
//*********************************************************************
function runDailyReport() {
    return fetchDailyReport()
        .then(sortDailyReport)
        .then(postDailyReport);
}

//*********************************************************************
// watchJira
//*********************************************************************
function watchJira() {
    // Set inveral to poll jira for P1 issues and post them to Circuit
    // Terminate on error will force the app to restart
    setInterval(() => {
        fetchIssues()
            .then(postIssues)
            .catch(terminate)
    }, config.jira.issuesPoll.interval * 60 * 1000);
    
    // Set interval to poll jira daily for a P0/P1 summary and post it to Circuit
    setInterval(() => {
        runDailyReport()
            .catch(logger.error)
    }, config.jira.reportPoll.interval * 60 * 60 * 1000);
    
    // Run first daily report now
    return runDailyReport();
}


//*********************************************************************
// run
//*********************************************************************
function run() {
    init()
        .then(logonCircuit)
        .then(logonJira)
        .then(watchJira)
        .then(done)
        .catch(terminate);
}

//*********************************************************************
// main
//*********************************************************************
run();
