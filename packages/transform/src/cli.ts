#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { transformPipeline } from './transform.js';
import { aggregateJobImpactAnalysis, calculateAggregatedSummary } from './aggregation.js';
import { detectPipelineType, getPipelineTypeInfo, countPipelinesByType } from './pipelineType.js';
import type { GitLabPipeline } from './types.js';

const program = new Command();

program
  .name('transform')
  .description('Transform GitLab pipeline data for frontend consumption')
  .version('1.0.0');

// Transform single pipeline command
program
  .command('pipeline')
  .description('Transform a single pipeline')
  .requiredOption('-f, --file <path>', 'Path to pipelines.json file')
  .requiredOption('-i, --iid <number>', 'Pipeline IID to transform')
  .option('--pretty', 'Pretty print JSON output')
  .action((options) => {
    try {
      const filePath = resolve(options.file);
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      const pipelines: GitLabPipeline[] = data;
      
      const pipeline = pipelines.find(p => p.iid.toString() === options.iid);
      
      if (!pipeline) {
        console.error(`Pipeline with IID ${options.iid} not found`);
        process.exit(1);
      }
      
      const result = transformPipeline(pipeline);
      
      if (options.pretty) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(JSON.stringify(result));
      }
      
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Aggregate job impacts across multiple pipelines
program
  .command('aggregate')
  .description('Aggregate job impact analysis across multiple pipelines')
  .requiredOption('-f, --file <path>', 'Path to pipelines.json file')
  .option('--limit <number>', 'Limit number of pipelines to analyze', parseInt)
  .option('--pretty', 'Pretty print JSON output')
  .action((options) => {
    try {
      const filePath = resolve(options.file);
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      let pipelines: GitLabPipeline[] = data;
      
      if (options.limit) {
        pipelines = pipelines.slice(0, options.limit);
      }
      
      const aggregated = aggregateJobImpactAnalysis(pipelines);
      const summary = calculateAggregatedSummary(aggregated);
      
      const result = {
        summary,
        totalPipelines: pipelines.length,
        jobImpacts: aggregated
      };
      
      if (options.pretty) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(JSON.stringify(result));
      }
      
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Detect pipeline types
program
  .command('types')
  .description('Analyze pipeline types distribution')
  .requiredOption('-f, --file <path>', 'Path to pipelines.json file')
  .option('--pretty', 'Pretty print JSON output')
  .action((options) => {
    try {
      const filePath = resolve(options.file);
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      const pipelines: GitLabPipeline[] = data;
      
      const typeCounts = countPipelinesByType(pipelines);
      const pipelinesWithTypes = pipelines.map(p => ({
        iid: p.iid,
        ref: p.ref,
        type: detectPipelineType(p),
        typeInfo: getPipelineTypeInfo(detectPipelineType(p)),
        status: p.status
      }));
      
      const result = {
        total: pipelines.length,
        distribution: typeCounts,
        pipelines: pipelinesWithTypes
      };
      
      if (options.pretty) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(JSON.stringify(result));
      }
      
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// List critical path for a pipeline
program
  .command('critical-path')
  .description('Show critical path for a pipeline')
  .requiredOption('-f, --file <path>', 'Path to pipelines.json file')
  .requiredOption('-i, --iid <number>', 'Pipeline IID')
  .option('--pretty', 'Pretty print JSON output')
  .action((options) => {
    try {
      const filePath = resolve(options.file);
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      const pipelines: GitLabPipeline[] = data;
      
      const pipeline = pipelines.find(p => p.iid.toString() === options.iid);
      
      if (!pipeline) {
        console.error(`Pipeline with IID ${options.iid} not found`);
        process.exit(1);
      }
      
      const result = transformPipeline(pipeline);
      
      const output = {
        pipelineId: result.pipelineId,
        pipelineIid: result.pipelineIid,
        totalDuration: result.totalDuration,
        criticalPath: result.criticalPath,
        criticalPathJobs: result.criticalPath?.map(node => {
          const job = result.jobs.find(j => j.id === node.jobId);
          return {
            jobId: node.jobId,
            jobName: job?.name,
            pipelineId: node.pipelineId,
            startTime: node.startTime,
            endTime: node.endTime,
            duration: node.endTime - node.startTime,
            dependencyType: node.dependencyType
          };
        })
      };
      
      if (options.pretty) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(JSON.stringify(output));
      }
      
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Show job impacts for a pipeline
program
  .command('job-impacts')
  .description('Show job impacts for a pipeline')
  .requiredOption('-f, --file <path>', 'Path to pipelines.json file')
  .requiredOption('-i, --iid <number>', 'Pipeline IID')
  .option('--top <number>', 'Show only top N jobs', parseInt, 10)
  .option('--pretty', 'Pretty print JSON output')
  .action((options) => {
    try {
      const filePath = resolve(options.file);
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      const pipelines: GitLabPipeline[] = data;
      
      const pipeline = pipelines.find(p => p.iid.toString() === options.iid);
      
      if (!pipeline) {
        console.error(`Pipeline with IID ${options.iid} not found`);
        process.exit(1);
      }
      
      const result = transformPipeline(pipeline);
      
      const topImpacts = result.jobImpacts
        .slice(0, options.top)
        .map(impact => ({
          jobId: impact.jobId,
          jobName: impact.job.name,
          jobStatus: impact.job.status,
          jobDuration: impact.job.duration,
          impact: impact.impact,
          percentage: impact.percentage
        }));
      
      const output = {
        pipelineId: result.pipelineId,
        pipelineIid: result.pipelineIid,
        totalDuration: result.totalDuration / 1000,
        totalJobs: result.jobImpacts.length,
        topImpacts
      };
      
      if (options.pretty) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(JSON.stringify(output));
      }
      
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Show timeline layout for a pipeline
program
  .command('timeline')
  .description('Show timeline layout for a pipeline')
  .requiredOption('-f, --file <path>', 'Path to pipelines.json file')
  .requiredOption('-i, --iid <number>', 'Pipeline IID')
  .option('--pretty', 'Pretty print JSON output')
  .action((options) => {
    try {
      const filePath = resolve(options.file);
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      const pipelines: GitLabPipeline[] = data;
      
      const pipeline = pipelines.find(p => p.iid.toString() === options.iid);
      
      if (!pipeline) {
        console.error(`Pipeline with IID ${options.iid} not found`);
        process.exit(1);
      }
      
      const result = transformPipeline(pipeline);
      
      const output = {
        pipelineId: result.pipelineId,
        pipelineIid: result.pipelineIid,
        timeRange: {
          earliestTime: result.earliestTime,
          latestTime: result.latestTime,
          totalDuration: result.totalDuration
        },
        timelineLayout: result.timelineLayout.map(pipelineData => ({
          pipelineId: pipelineData.pipelineId,
          isParent: pipelineData.isParent,
          stages: pipelineData.stages.map(stage => ({
            name: stage.name,
            jobCount: stage.jobs.length,
            jobs: stage.jobs.map(job => ({
              id: job.id,
              name: job.name,
              status: job.status,
              startPercent: job.startPercent,
              widthPercent: job.widthPercent,
              pendingStartPercent: job.pendingStartPercent,
              pendingWidthPercent: job.pendingWidthPercent
            }))
          }))
        }))
      };
      
      if (options.pretty) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(JSON.stringify(output));
      }
      
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
