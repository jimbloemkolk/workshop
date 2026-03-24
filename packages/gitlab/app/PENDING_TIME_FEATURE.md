# Pending Time Feature - Implementation Notes

## What Was Added

The pipeline timeline now visualizes **pending time** - the duration between when a job is created and when it actually starts executing.

## Visual Representation

### Timeline View
- **Dashed lines** = Pending time (waiting for runner/resources)
- **Solid colored bars** = Active execution time

Example:
```
Created  →  [- - - - - -]  →  Started  →  [████████]  →  Finished
            Pending Time         Execution Time
```

## Implementation Details

### 1. Timeline Component (`PipelineTimeline.tsx`)
- Calculate pending time: `created_at` to `started_at`
- Position dashed line before solid bar
- Include `created_at` in timeline bounds calculation

### 2. Visual Styling (`PipelineTimeline.css`)
- `.job-pending` class with CSS dashed pattern
- Uses `repeating-linear-gradient` for dashed effect
- Positioned at 50% height, centered vertically
- Gray color (`#9ca3af`) to differentiate from execution bars

### 3. Job Detail Modal (`JobDetail.tsx`)
- Added "Pending Time" section
- Shows formatted duration
- Only displays if both `created_at` and `started_at` exist

### 4. Legend (`App.tsx`)
- Visual legend explaining both representations
- Solid box = execution time
- Dashed box = pending time

## Sample Data

Updated sample pipelines to show realistic pending times:
- Build jobs: 1-5 minute pending times
- Test jobs: 2-9 minute pending times (waiting for builds)
- Deploy jobs: 3-4 minute pending times (waiting for tests)

## Why This Matters

Pending time visualization helps identify:
- **Runner availability issues** - Long pending times indicate runner shortage
- **Dependency bottlenecks** - Jobs waiting for upstream dependencies
- **Resource contention** - Multiple jobs competing for limited runners
- **Queue optimization opportunities** - Where to add more runners

## Color Coding

The pending line uses a neutral gray (`#9ca3af`) because:
- It's not a job status (success/failed/etc.)
- It's a "waiting" state, not an "active" state
- Gray doesn't compete with the status colors

## Example Use Cases

1. **Pipeline with immediate start**: No dashed line (or very short)
2. **Pipeline with runner wait**: Long dashed line before execution
3. **Dependent jobs**: Dashed line extends until dependencies complete
4. **Parallel jobs**: Multiple dashed lines at same time (runner contention)

## Technical Notes

- Pending time is calculated client-side from timestamps
- No additional API calls needed
- Works with existing GitLab job data structure
- Gracefully handles missing timestamps (falls back to execution time only)
