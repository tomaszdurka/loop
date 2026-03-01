module.exports = {
  apps: [
    {
      name: 'gateway',
      namespace: 'agentic-loop',
      cwd: '/Users/tomasz/projects/akrudio/worker',
      script: '/bin/bash',
      args: '-c "npm run queue:api"',
      time: true
    },
    {
      name: 'worker',
      namespace: 'agentic-loop',
      cwd: '/Users/tomasz/projects/akrudio/worker',
      script: '/bin/bash',
      args: '-c "npm run loop -- worker --stream-job-logs"',
      time: true
    },
    {
      name: 'ui',
      namespace: 'agentic-loop',
      cwd: '/Users/tomasz/projects/akrudio/worker',
      script: '/bin/bash',
      args: '-c "cd ui && npm run build && npm run start"',
      time: true
    }
  ]
};
