/**
 * API metrics tracker for monitoring API call performance.
 * 
 * Fully generic — tracks duration and categorizes by endpoint name.
 * Shared across all API calls in the process.
 */

export interface ApiCallMetrics {
  endpoint: string;
  duration: number;
  timestamp: number;
}

export interface ApiMetricsSummary {
  totalCalls: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  p50: number;
  p95: number;
  p99: number;
  byEndpoint: {
    [endpoint: string]: {
      count: number;
      avgDuration: number;
      maxDuration: number;
    };
  };
}

export class ApiMetricsTracker {
  private calls: ApiCallMetrics[] = [];
  private callsByEndpoint: Map<string, ApiCallMetrics[]> = new Map();

  recordCall(endpoint: string, duration: number) {
    const metric: ApiCallMetrics = {
      endpoint,
      duration,
      timestamp: Date.now(),
    };

    this.calls.push(metric);

    if (!this.callsByEndpoint.has(endpoint)) {
      this.callsByEndpoint.set(endpoint, []);
    }
    this.callsByEndpoint.get(endpoint)!.push(metric);
  }

  getSummary(): ApiMetricsSummary {
    if (this.calls.length === 0) {
      return {
        totalCalls: 0,
        avgDuration: 0,
        minDuration: 0,
        maxDuration: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        byEndpoint: {},
      };
    }

    const sortedDurations = [...this.calls].map(c => c.duration).sort((a, b) => a - b);

    const percentile = (arr: number[], p: number): number => {
      const index = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, index)] || 0;
    };

    const byEndpoint: ApiMetricsSummary['byEndpoint'] = {};
    for (const [endpoint, calls] of this.callsByEndpoint.entries()) {
      const durations = calls.map(c => c.duration);
      byEndpoint[endpoint] = {
        count: calls.length,
        avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
        maxDuration: Math.max(...durations),
      };
    }

    return {
      totalCalls: this.calls.length,
      avgDuration: sortedDurations.reduce((a, b) => a + b, 0) / sortedDurations.length,
      minDuration: Math.min(...sortedDurations),
      maxDuration: Math.max(...sortedDurations),
      p50: percentile(sortedDurations, 50),
      p95: percentile(sortedDurations, 95),
      p99: percentile(sortedDurations, 99),
      byEndpoint,
    };
  }

  reset() {
    this.calls = [];
    this.callsByEndpoint.clear();
  }
}

/** Global singleton instance shared across all API calls in the process */
export const apiMetrics = new ApiMetricsTracker();
