const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createSessionId() {
  return crypto.randomBytes(4).toString('hex');
}

function formatDateForLogDir(now = new Date()) {
  const value = new Date(now);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function resolveLogFilePath({ workspaceRoot, logDir = 'logs', sessionId, now = new Date() }) {
  const baseDir = path.isAbsolute(logDir) ? logDir : path.join(workspaceRoot, logDir);
  return path.join(baseDir, formatDateForLogDir(now), `${sessionId}.log`);
}

function renderLogLine(entry) {
  const parts = ['[log]', `session=${entry.sessionId}`, `event=${entry.event}`];

  if (entry.step !== undefined) {
    parts.push(`step=${entry.step}`);
  }

  if (entry.toolName) {
    parts.push(`tool=${entry.toolName}`);
  }

  return `${parts.join(' ')}\n`;
}

function createSessionLogger({
  workspaceRoot,
  sessionId,
  logDir = 'logs',
  logToCli = false,
  cliWriter = () => {},
  now = new Date(),
}) {
  const filePath = resolveLogFilePath({ workspaceRoot, logDir, sessionId, now });

  return {
    sessionId,
    filePath,
    async log(event) {
      const entry = {
        timestamp: new Date().toISOString(),
        sessionId,
        ...event,
      };

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');

      if (logToCli) {
        cliWriter(renderLogLine(entry));
      }

      return entry;
    },
  };
}

module.exports = {
  createSessionId,
  createSessionLogger,
  formatDateForLogDir,
  renderLogLine,
  resolveLogFilePath,
};
