# 🦊 GitLab Pipeline Visualizer - Quick Start Guide

## 📋 What You Need

Before starting, make sure you have:
- **Node.js** (v18 or higher) - [Download here](https://nodejs.org/)
- **glab CLI** - GitLab's official CLI tool

## 🚀 Installation

### 1. Install glab CLI (if not already installed)

**macOS:**
```bash
brew install glab
```

**Linux:**
```bash
# Using snap
sudo snap install glab

# Or download from releases
curl -L https://gitlab.com/gitlab-org/cli/-/releases/permalink/latest/downloads/glab_linux_amd64.tar.gz | tar xz
sudo mv glab /usr/local/bin/
```

**Windows:**
```powershell
# Using scoop
scoop install glab

# Or using chocolatey
choco install glab
```

### 2. Authenticate with GitLab

```bash
glab auth login
```

Follow the prompts to authenticate with your GitLab account.

### 3. Install Project Dependencies

```bash
npm install
```

## 📊 Fetching Pipeline Data

To visualize pipelines, you first need to fetch the data from your GitLab project:

```bash
node fetch-pipelines.js <project-path> [days]
```

### Examples:

```bash
# Fetch pipelines from the last 30 days
node fetch-pipelines.js mygroup/myproject 30

# Fetch pipelines from the last 7 days
node fetch-pipelines.js username/repository 7

# Fetch pipelines from the last 90 days
node fetch-pipelines.js gitlab-org/gitlab 90
```

### What This Does:

- Connects to GitLab using your authenticated glab CLI
- Fetches all pipelines within the specified time range
- Downloads detailed job information for each pipeline
- Saves everything to `public/data/pipelines.json`
- Creates a metadata file at `public/data/metadata.json`

**Note:** The script includes rate limiting protection (0.5s delay between requests).

## 🎨 Running the Application

Once you have fetched the pipeline data:

```bash
npm run dev
```

Then open your browser to: **http://localhost:5173**

## ⌨️ Using the Application

### Navigation
- **← (Left Arrow)**: View previous pipeline
- **→ (Right Arrow)**: View next pipeline

### Features
- **Timeline View**: See all jobs with their start times, durations, and status
- **Color Coding**: Jobs are color-coded by status:
  - 🟢 Green = Success
  - 🔴 Red = Failed
  - 🔵 Blue = Running
  - 🟡 Yellow = Pending
  - ⚪ Gray = Canceled
  - 🟣 Purple = Skipped

- **Click Jobs**: Click any job to see detailed information:
  - Status
  - Duration
  - Start/end times
  - Triggered by (user)
  - Runner information
  - Direct link to GitLab

## 🔄 Updating Data

To refresh your pipeline data, simply run the fetch script again:

```bash
node fetch-pipelines.js mygroup/myproject 30
```

The app will automatically load the new data on refresh.

## 🏗️ Building for Production

```bash
# Build the application
npm run build

# Preview the production build
npm run preview
```

## 📁 Project Structure

```
gitlab-analysis/
├── fetch-pipelines.js          # Data fetching script
├── public/
│   └── data/
│       ├── pipelines.json      # Your pipeline data
│       └── metadata.json       # Fetch metadata
├── src/
│   ├── App.tsx                 # Main app component
│   ├── components/
│   │   ├── PipelineTimeline.tsx   # Timeline visualization
│   │   ├── PipelineTimeline.css
│   │   ├── JobDetail.tsx          # Job detail modal
│   │   └── JobDetail.css
│   └── types/
│       └── gitlab.ts           # TypeScript types
└── README.md
```

## 🐛 Troubleshooting

### "Failed to load pipeline data"
- Make sure you've run `node fetch-pipelines.js <project-path> [days]`
- Check that `public/data/pipelines.json` exists

### "glab: command not found"
- Install glab CLI (see Installation section above)
- Make sure it's in your PATH

### "Authentication failed"
- Run `glab auth login` to authenticate
- Make sure you have access to the GitLab project

### Empty or No Pipelines
- Check that the project has pipelines in the specified date range
- Try increasing the number of days: `node fetch-pipelines.js project/name 90`

## 🎯 Tips

1. **Start Small**: Begin with a short date range (7 days) to test
2. **Large Projects**: For projects with many pipelines, fetching can take time
3. **Multiple Projects**: You can fetch data for different projects - just run the script again with a different project path
4. **Sample Data**: The app comes with sample data so you can test it immediately

## 📖 Additional Resources

- [GitLab CLI Documentation](https://gitlab.com/gitlab-org/cli)
- [GitLab API Documentation](https://docs.gitlab.com/ee/api/)
- [Vite Documentation](https://vitejs.dev/)
- [React Documentation](https://react.dev/)

## 🤝 Support

If you encounter issues:
1. Check that glab is properly installed and authenticated
2. Verify you have access to the GitLab project
3. Ensure the project has pipelines in the specified date range
4. Check the console for error messages

Happy visualizing! 🎉
