/**
 * Task runner — the main orchestrator that runs a FetchTask with a Writer,
 * optionally rendering the TUI for progress display.
 * 
 * This is the glue that entry points call after composing their task + writer.
 */

import React from 'react';
import { render } from 'ink';
import type { FetchTask, Writer, RunOptions, TaskContext } from './types.js';
import { GenericFetchApp } from './ui/GenericFetchApp.js';

/**
 * Run a fetch task with the given writer and options.
 * 
 * In TUI mode (default): renders an Ink terminal UI with progress.
 * In debug mode: runs the task with console.log output, no TUI.
 * In stdout mode: suppresses all console output, uses the writer.
 */
export async function runFetchTask<TResult>(
  task: FetchTask<TResult>,
  writer: Writer<TResult>,
  options: RunOptions = {}
): Promise<void> {
  const { debug, stdout, ...writeOptions } = options;

  // stdout mode: suppress console output
  if (stdout) {
    const originalLog = console.log;
    console.log = () => {};

    try {
      const context = createDebugContext(task.name);
      const result = await task.run(context);
      await writer.write(result, { ...writeOptions, stdout: true });
    } finally {
      console.log = originalLog;
    }
    return;
  }

  // debug mode: plain console output, no TUI
  if (debug) {
    const context = createDebugContext(task.name);
    const result = await task.run(context);
    await writer.write(result, writeOptions);
    console.log('\n🎉 Done!');
    return;
  }

  // TUI mode: render Ink UI
  let taskResult: TResult | undefined;

  const { waitUntilExit } = render(
    React.createElement(GenericFetchApp, {
      title: task.name,
      subtitle: options.subtitle,
      onComplete: () => {
        setTimeout(() => process.exit(0), 2000);
      },
      runTask: async (context: TaskContext) => {
        taskResult = await task.run(context);
        await writer.write(taskResult, writeOptions);
      },
    })
  );

  await waitUntilExit();
}

/**
 * Create a simple TaskContext that logs to console (for debug/stdout modes).
 */
function createDebugContext(taskName: string): TaskContext {
  return {
    updateProgress(current: number, total: number) {
      console.log(`  [${current}/${total}]`);
    },
    updatePhase(phase: string) {
      console.log(`\n📋 ${phase}`);
    },
    setDetail(key: string, value: string | number) {
      console.log(`  ${key}: ${value}`);
    },
    incrementDetail(_key: string, _amount: number = 1) {
      // Silent in debug mode — too noisy
    },
    setCurrentItem(label: string) {
      console.log(`  → ${label}`);
    },
    log(type: 'info' | 'warning' | 'error' | 'success', message: string) {
      const prefix = type === 'error' ? '❌' : type === 'warning' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';
      console.log(`${prefix} ${message}`);
    },
    reportApiMetrics() {
      // Silent in debug mode
    },
  };
}
