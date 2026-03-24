# GitLab Pipeline Visualizer

A React application for visualizing GitLab CI/CD pipelines with detailed job timing and duration information.

## Features

- **Multi-Dataset Support**: Fetch and analyze pipelines from multiple GitLab projects or repositories
- **Timeline Visualization**: See all jobs in a pipeline with their start times, durations, and end times
  - Solid bars show job execution time
  - Dashed lines show pending time (waiting to start)
- **Dataset Picker**: Switch between different datasets in the UI
- **Keyboard Navigation**: Use arrow keys (← →) to navigate between different pipelines
- **Job Details**: Click on any job to see detailed information including:
  - Job status
  - Duration
  - Pending time
  - Start and end times
  - Link to GitLab web view
  - Stage information
- **Color Coding**: Jobs are color-coded by status (success, failed, pending, etc.)
- **Pipeline Statistics**: Aggregated analysis across multiple pipelines

## Prerequisites

- Node.js (v18 or higher)
- **Option 1**: [glab CLI](https://gitlab.com/gitlab-org/cli) - GitLab CLI tool (recommended)
- **Option 2**: GitLab Personal Access Token (for direct API access)

### Option 1: Installing glab CLI

```bash
# macOS
brew install glab

# Login to GitLab
glab auth login
```

### Option 2: GitLab Personal Access Token

Create a personal access token at:
- GitLab.com: https://gitlab.com/-/profile/personal_access_tokens
- Self-hosted: https://your-gitlab-instance/-/profile/personal_access_tokens

Required scopes: `read_api`

Then set it as an environment variable:
```bash
export GITLAB_TOKEN=your_token_here

# Optional: Set custom GitLab URL for self-hosted instances
export GITLAB_URL=https://your-gitlab-instance.com
```

## Setup

1. Install dependencies:
```bash
npm install
```

2. Fetch pipeline data from your GitLab project:

**Using the new fetcher (TypeScript, recommended):**
```bash
npx tsx packages/fetcher/fetch-pipelines.ts <project-path> [days] [options]
```

Options:
- `--dataset-name <name>`: Custom name for the dataset (defaults to project name)
- `--rebuild`: Rebuild from scratch
- `--debug`: Show detailed debug output

Example:
```bash
# Fetch last 30 days
npx tsx packages/fetcher/fetch-pipelines.ts mygroup/myproject 30

# With custom dataset name
npx tsx packages/fetcher/fetch-pipelines.ts mygroup/myproject 30 --dataset-name my-dataset
```

**Legacy fetchers (still supported):**
```bash
# Using glab CLI
node fetch-pipelines.js <project-path> [days]

# Using GitLab API directly
export GITLAB_TOKEN=your_token_here
node fetch-pipelines-api.js <project-path> [days]
```

3. Discover datasets (makes them available in the app):
```bash
npm run discover-datasets
```

4. Start the development server:
```bash
npm run dev
```

5. Open http://localhost:5173 in your browser

## Multi-Dataset Support

The app now supports multiple datasets! See [MULTI_DATASET_GUIDE.md](./MULTI_DATASET_GUIDE.md) for detailed information on:
- Fetching data from multiple repositories
- Managing datasets
- Switching between datasets in the UI
- Migrating existing data

Quick example:
```bash
# Fetch from first project
npx tsx packages/fetcher/fetch-pipelines.ts group/project1 30

# Fetch from second project
npx tsx packages/fetcher/fetch-pipelines.ts group/project2 30

# Discover all datasets
npm run discover-datasets

# Start the app
npm run dev
```

## Features

- **Timeline Visualization**: See all jobs in a pipeline with their start times, durations, and end times
  - Solid bars show job execution time
  - Dashed lines show pending time (waiting to start)
- **Keyboard Navigation**: Use arrow keys (← →) to navigate between different pipelines
- **Job Details**: Click on any job to see detailed information including:
  - Job status
  - Duration
  - Pending time
  - Start and end times
  - Link to GitLab web view
  - Stage information
- **Color Coding**: Jobs are color-coded by status (success, failed, pending, etc.)

## Usage

1. Fetch your pipeline data using the fetch script
2. Launch the app
3. Use left/right arrow keys to cycle through pipelines
4. Click on jobs to see more details

## Project Structure

```
├── packages/
│   ├── app/                   # React frontend application
│   │   ├── public/
│   │   │   ├── datasets/      # Dataset storage (multi-dataset support)
│   │   │   │   ├── project1/
│   │   │   │   │   ├── pipelines.json
│   │   │   │   │   └── metadata.json
│   │   │   │   └── project2/
│   │   │   │       ├── pipelines.json
│   │   │   │       └── metadata.json
│   │   │   └── datasets.json  # Auto-generated dataset index
│   │   ├── scripts/           # Build-time scripts
│   │   │   ├── discover-datasets.ts
│   │   │   └── migrate-data.ts
│   │   └── src/
│   │       ├── App.tsx        # Main application
│   │       ├── components/    # React components
│   │       └── types/         # TypeScript types
│   ├── fetcher/               # Pipeline data fetcher (TypeScript)
│   │   ├── fetch-pipelines.ts # Main fetch script
│   │   └── fetching/          # Fetching logic
│   └── transform/             # Pipeline transformation logic
│       └── src/
│           ├── cli.ts         # CLI for transform package
│           ├── transform.ts   # Core transformation
│           └── aggregation.ts # Job impact analysis
├── fetch-pipelines.js         # Legacy fetch script (glab CLI)
├── README.md
└── MULTI_DATASET_GUIDE.md     # Multi-dataset documentation
```

## Development

```bash
# Install dependencies
npm install

# Run dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Fetch pipeline data
npx tsx packages/fetcher/fetch-pipelines.ts <project-path> [days]

# Discover datasets
npm run discover-datasets

# Migrate old data structure
npm run migrate-data

# Transform package CLI (for analysis)
npm run transform -- <command> [options]
```

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT
