# @workshop/transform

Transform and analyze GitLab pipeline data with dependency calculation.

## Installation

From the workspace root:
```bash
npm install
```

## CLI Usage

The package includes a CLI tool for debugging transformations:

### List pipelines
```bash
npm run transform -- list -f packages/app/public/data/pipelines.json
```

### Analyze dependencies for a pipeline
```bash
npm run transform -- deps -f packages/app/public/data/pipelines.json -i 23904
```

Filter to a specific job:
```bash
npm run transform -- deps -f packages/app/public/data/pipelines.json -i 23904 -j lint_type_and_test
```

Output as JSON:
```bash
npm run transform -- deps -f packages/app/public/data/pipelines.json -i 23904 --json
```

### Show job details
```bash
npm run transform -- job -f packages/app/public/data/pipelines.json -i 23904 -j 10728180
```

## API Usage

```typescript
import { calculateDependencies } from '@workshop/transform';

const result = calculateDependencies(pipeline);

// Access transformed data
console.log(result.allJobsWithPipeline);
console.log(result.dependencies);
console.log(result.pipelineHierarchy);
```

## Features

- Calculate all job dependencies (needs, stage-based, and cross-pipeline trigger dependencies)
- Compute implicit stage dependencies for trigger jobs
- Build pipeline hierarchy maps
- Transform pipeline data with timing information
