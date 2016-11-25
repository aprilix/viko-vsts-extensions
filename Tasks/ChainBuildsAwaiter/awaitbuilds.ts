import tl = require('vsts-task-lib/task');
import trm = require('vsts-task-lib/toolrunner');
import ents = require('html-entities');
import path = require('path');
import fs = require('fs');

import Q = require("q");

import * as vm from 'vso-node-api';
import {ApiHelper} from 'vsts-specflow/apihelper';
import {Feature,Scenario} from  'vsts-specflow/specflow';
import * as bi from 'vso-node-api/interfaces/BuildInterfaces';
import * as ci from 'vso-node-api/interfaces/CoreInterfaces';
import * as ti from 'vso-node-api/interfaces/TestInterfaces';
import * as wi from 'vso-node-api/interfaces/WorkItemTrackingInterfaces';

let trx = require('node-trx');  


var buildList = [];
var buildDefinitions = [];

let apihelper = new ApiHelper();
let api = apihelper.getApi();
var projId = null;
let testPublisher  = new tl.TestPublisher("VSTest");
var passedTests=0,totalTests=0;

async function processTestRun(testRun:ti.TestRun) {
    var testResults = await api.getTestApi().getTestResults(projId,testRun.id);
    var run = new trx.TestRun({name: testRun.name,
        times: {creation: testRun.createdDate.toISOString(),
                start: testRun.startedDate.toISOString(),
                queuing: testRun.createdDate.toISOString(), 
                finish: testRun.completedDate.toISOString()
            }});
    for(var tres of testResults) {
        run.addResult({test: new trx.UnitTest({
                name: tres.testCase.name,
                methodName: tres.automatedTestName,
                methodCodeBase: tres.automatedTestStorage,
                methodClassName: tres.automatedTestName,
                description: tres.comment            
            }),
            computerName: tres.computerName,
            outcome:tres.outcome,
            duration: new Date(tres.durationInMs).toTimeString(),
            errorMessage: tres.errorMessage,
            errorStackTrace: tres.stackTrace,
            startTime: tres.startedDate.toISOString(),
            endTime: tres.completedDate.toISOString()            
        });
    }
    var filepath = path.join(tl.getVariable("Agent.BuildDirectory"),`${testRun.name}.trx`);
    fs.writeFileSync(filepath,run.toXml());
    testPublisher.publish(filepath,"false",testRun.buildConfiguration.platform,testRun.buildConfiguration.flavor,testRun.name,"false");
}

async function processBuilds(buildList: number[]) : Promise<number[]>{
    let bapi = api.getBuildApi();
    var remainBuilds:number[] = []
    for(var buildId of buildList) {
        let build = await bapi.getBuild(buildId,projId);
        if(build.status!=bi.BuildStatus.Completed) {
            remainBuilds.push(buildId);
            continue;
        }
        //build completed store results
        console.log(tl.loc("processingBuild",build.definition.name));
        var testRuns = await api.getTestApi().getTestRuns(projId,`vstfs:///Build/Build/${buildId}`);
        for(var testRun of testRuns) {
            console.log(tl.loc("processingRun",testRun.name));
            var testRunDetailed = await api.getTestApi().getTestRunById(projId,testRun.id); 
            processTestRun(testRunDetailed);
            console.log(tl.loc("testRunOutcome",testRun.totalTests,testRun.passedTests));
            passedTests+=testRun.passedTests;
            totalTests+=testRun.totalTests;
        }
    }

    return remainBuilds;    
}

async function run() : Promise<number>{
    tl.setResourcePath(path.join(__dirname, 'task.json'));
    projId = tl.getVariable("System.TeamProjectId");
    let strBuildList = tl.getVariable("queuedBuilds");
    let sleepBetweenIters = Number.parseInt(tl.getInput("sleepBetweenIters"));
    if(strBuildList==null) throw new Error("queuedBuilds initialization error. Check that Chain Builds Starter present in the build before the Awaiter");
    console.log(tl.loc("queuedBuilds",strBuildList));
    try {
        var buildList = strBuildList.split(",").map(e => Number.parseInt(e));
        let bapi = api.getBuildApi();
        //generate .md file for the summary page
        var filepath = path.join(tl.getVariable("Agent.BuildDirectory"),`buildList.md`);
        var dataStr="";
        for(let bid of buildList) {
            let build = await bapi.getBuild(bid,projId);
            dataStr+=`[Build ${build.definition.name}](${build._links.web.href})<br>\n`;
        }
        fs.writeFileSync(filepath,dataStr);
        tl._writeLine("##vso[task.addattachment type=Distributedtask.Core.Summary;name=Original Builds;]"+filepath);
        while(buildList.length>0) {
            buildList = await processBuilds(buildList);
            console.log(tl.loc("buildsToWait",buildList.length));
            if(buildList.length>0) {
                console.log(tl.loc("sleeping",sleepBetweenIters));
                await new Promise(resolve => setTimeout(resolve,sleepBetweenIters*1000));
            }
        }
        //1 - passed, 2 - passed with issues, 3 - failed
        let result = passedTests==totalTests ? 1 : passedTests==0 ? 3 : 2;
        let res = Q.defer<number>();
        res.resolve(result);
        return res.promise;
    } catch (err) {
        console.log(err);
        tl.debug(err.stack);
        throw err;        
    }


}


//tl.setVariable("System.TeamProjectId","40e8bc90-32fa-48f4-b43a-446f8ec3f084");
//tl.setVariable("queuedBuilds","10716");
//tl.setVariable("Agent.BuildDirectory","/dev/temp/");

run()
.then(r => {switch(r) {
    case 1: tl.setResult(tl.TaskResult.Succeeded,tl.loc("taskSucceeded"));break;
    case 2: tl._writeLine("##vso[task.complete result=SucceededWithIssues;]");break;
    case 3: 
    default: tl.setResult(tl.TaskResult.Failed,tl.loc("taskSucceeded"));
}})
.catch(r => tl.setResult(tl.TaskResult.Failed,tl.loc("taskFailed")))
