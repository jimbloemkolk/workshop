import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The merge date we're analyzing
const MERGE_DATE = new Date('2025-11-05T11:42:44+01:00');

/**
 * Calculate mean and standard deviation
 */
function calculateStats(durations) {
  if (durations.length === 0) return { mean: 0, stdDev: 0, count: 0 };
  
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  const variance = durations.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / durations.length;
  const stdDev = Math.sqrt(variance);
  
  return { mean, stdDev, count: durations.length };
}

/**
 * Parse pipeline duration in seconds
 */
function getPipelineDuration(pipeline) {
  if (!pipeline.created_at || !pipeline.updated_at) return null;
  
  const createdAt = new Date(pipeline.created_at);
  const updatedAt = new Date(pipeline.updated_at);
  const durationMs = updatedAt - createdAt;
  
  // Return duration in seconds, only if positive
  const durationSecs = durationMs / 1000;
  return durationSecs > 0 ? durationSecs : null;
}

/**
 * Calculate cumulative percentage of pipelines finished below each time threshold
 */
function getCumulativePercentages(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const result = {};
  
  for (let minutes = 5; minutes <= 60; minutes += 5) {
    const threshold = minutes * 60; // Convert to seconds
    const count = sorted.filter(d => d <= threshold).length;
    const percentage = (count / sorted.length * 100).toFixed(1);
    result[minutes] = { count, percentage };
  }
  
  return result;
}

/**
 * Export duration datasets to CSV file
 */
function exportToCSV(beforeMerge, afterMerge, outputPath) {
  const maxLength = Math.max(beforeMerge.length, afterMerge.length);
  
  // Create CSV content
  let csv = 'Before Merge (minutes),After Merge (minutes)\n';
  
  for (let i = 0; i < maxLength; i++) {
    const before = beforeMerge[i] !== undefined ? (beforeMerge[i] / 60).toFixed(2) : '';
    const after = afterMerge[i] !== undefined ? (afterMerge[i] / 60).toFixed(2) : '';
    csv += `${before},${after}\n`;
  }
  
  fs.writeFileSync(outputPath, csv, 'utf-8');
  console.log(`\n📊 CSV exported to: ${outputPath}`);
}

async function analyzePipeline() {
  try {
    // Check for --export-csv flag
    const exportCSV = process.argv.includes('--export-csv');
    
    // Get cutoff minutes from --cutoff argument, default to 100
    let cutoffMinutes = 100;
    const cutoffArg = process.argv.find(arg => arg.startsWith('--cutoff='));
    if (cutoffArg) {
      const value = parseInt(cutoffArg.split('=')[1], 10);
      if (!isNaN(value) && value > 0) {
        cutoffMinutes = value;
      }
    }
    
    console.log('Reading pipelines.json...');
    const filePath = path.join(__dirname, 'public/data/pipelines.json');
    const data = fs.readFileSync(filePath, 'utf-8');
    
    console.log('Parsing JSON...');
    const pipelines = JSON.parse(data);
    
    if (!Array.isArray(pipelines)) {
      console.error('Expected an array of pipelines');
      process.exit(1);
    }
    
    console.log(`Found ${pipelines.length} total pipelines\n`);
    
    // Separate pipelines before and after the merge
    const beforeMerge = [];
    const afterMerge = [];
    const beforeMergeFiltered = [];
    const afterMergeFiltered = [];
    
    const MAX_DURATION_SECS = cutoffMinutes * 60; // Convert cutoff to seconds
    
    for (const pipeline of pipelines) {
      if (!pipeline.created_at) continue;
      
      const pipelineDate = new Date(pipeline.created_at);
      const duration = getPipelineDuration(pipeline);
      
      if (duration === null) continue;
      
      if (pipelineDate < MERGE_DATE) {
        beforeMerge.push(duration);
        if (duration <= MAX_DURATION_SECS) {
          beforeMergeFiltered.push(duration);
        }
      } else {
        afterMerge.push(duration);
        if (duration <= MAX_DURATION_SECS) {
          afterMergeFiltered.push(duration);
        }
      }
    }
    
    // Calculate statistics (using only pipelines under 60 minutes)
    const statsBefore = calculateStats(beforeMergeFiltered);
    const statsAfter = calculateStats(afterMergeFiltered);
    
    // Display results
    console.log(`\n${'='.repeat(60)}`);
    console.log('PIPELINE DURATION ANALYSIS');
    console.log(`${'='.repeat(60)}`);
    console.log(`Merge Date: ${MERGE_DATE.toISOString()}`);
    console.log(`(Only analyzing pipelines under ${cutoffMinutes} minutes)\n`);
    
    console.log('BEFORE MERGE:');
    console.log(`  Total Pipelines: ${beforeMerge.length}`);
    console.log(`  Pipelines < ${cutoffMinutes} min: ${statsBefore.count} (filtered out ${beforeMerge.length - statsBefore.count})`);
    console.log(`  Average Duration: ${(statsBefore.mean / 60).toFixed(2)} minutes`);
    console.log(`  Std Deviation: ${(statsBefore.stdDev / 60).toFixed(2)} minutes\n`);
    
    console.log('AFTER MERGE:');
    console.log(`  Total Pipelines: ${afterMerge.length}`);
    console.log(`  Pipelines < ${cutoffMinutes} min: ${statsAfter.count} (filtered out ${afterMerge.length - statsAfter.count})`);
    console.log(`  Average Duration: ${(statsAfter.mean / 60).toFixed(2)} minutes`);
    console.log(`  Std Deviation: ${(statsAfter.stdDev / 60).toFixed(2)} minutes\n`);
    
    // Calculate changes
    const meanChange = statsAfter.mean - statsBefore.mean;
    const meanChangePercent = (meanChange / statsBefore.mean * 100).toFixed(2);
    const stdDevChange = statsAfter.stdDev - statsBefore.stdDev;
    const stdDevChangePercent = (stdDevChange / statsBefore.stdDev * 100).toFixed(2);
    
    console.log('CHANGES:');
    console.log(`  Average Duration Change: ${(meanChange / 60).toFixed(2)} minutes (${meanChangePercent}%)`);
    console.log(`  Std Deviation Change: ${(stdDevChange / 60).toFixed(2)} minutes (${stdDevChangePercent}%)`);
    console.log(`${'='.repeat(60)}\n`);
    
    if (meanChange > 0) {
      console.log(`⚠️  Pipelines got SLOWER on average after the merge`);
    } else if (meanChange < 0) {
      console.log(`✅ Pipelines got FASTER on average after the merge`);
    } else {
      console.log(`➖ No significant change in average pipeline duration`);
    }
    
    // Calculate and display cumulative percentages
    const cumulativeBefore = getCumulativePercentages(beforeMergeFiltered);
    const cumulativeAfter = getCumulativePercentages(afterMergeFiltered);
    
    console.log('\nCUMULATIVE COMPLETION PERCENTAGES:');
    console.log(`${'Time (min)'.padEnd(12)} | ${'Before'.padEnd(15)} | ${'After'.padEnd(15)} | Difference`);
    console.log(`${'-'.repeat(60)}`);
    
    for (let minutes = 5; minutes <= 60; minutes += 5) {
      const before = cumulativeBefore[minutes];
      const after = cumulativeAfter[minutes];
      const diff = (parseFloat(after.percentage) - parseFloat(before.percentage)).toFixed(1);
      
      console.log(
        `${minutes.toString().padEnd(12)} | ${before.percentage.padStart(6)}% (${before.count.toString().padStart(4)}) | ${after.percentage.padStart(6)}% (${after.count.toString().padStart(4)}) | ${diff > 0 ? '+' : ''}${diff}%`
      );
    }
    console.log();
    
    // Export to CSV if requested
    if (exportCSV) {
      const csvPath = path.join(__dirname, 'pipeline-durations.csv');
      exportToCSV(beforeMergeFiltered, afterMergeFiltered, csvPath);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

analyzePipeline();
