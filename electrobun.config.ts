export default {
  app: {
    name: 'Claude Session Restore',
    identifier: 'dev.csr.claude-session-restore',
    version: '0.1.0',
    description: 'Restore your Claude Code sessions after a shutdown, and manage every chat.',
  },
  build: {
    buildFolder: 'build',
    artifactFolder: 'artifacts',
    bun: {
      entrypoint: 'src/bun/index.ts',
    },
    views: {
      mainview: {
        entrypoint: 'src/mainview/index.ts',
      },
    },
    copy: {
      'src/mainview/index.html': 'views/mainview/index.html',
      'src/mainview/styles.css': 'views/mainview/styles.css',
    },
    mac: {
      codesign: false,
      notarize: false,
      createDmg: false,
    },
  },
};
