module.exports = {
  apps: [
    {
      name: 'gateway',
      namespace: 'agentic-loop',
      cwd: '/Users/tomasz/projects/akrudio/worker',
      script: '/bin/bash',
      args: '-lc "npm run queue:api"',
      time: true
    },
    {
      name: 'worker',
      namespace: 'agentic-loop',
      cwd: '/Users/tomasz/projects/akrudio/worker',
      script: '/bin/bash',
      args: '-lc "npm run loop -- worker --stream-job-logs"',
      time: true
    },
    {
      name: 'ui',
      namespace: 'agentic-loop',
      cwd: '/Users/tomasz/projects/akrudio/worker',
      script: '/bin/bash',
      args: '-lc "cd ui && npm run build && npm run start"',
      time: true
    }
  ]
};
