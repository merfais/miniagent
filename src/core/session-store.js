const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const INLINE_TOOL_RESULT_LIMIT = 16 * 1024;
const SESSION_META_LOCK_RETRY_MS = 5;

function createSessionStore({
  workspaceRoot,
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
  fsImpl = fs,
} = {}) {
  if (!workspaceRoot) {
    throw new Error('workspaceRoot is required');
  }

  const sessionsRoot = path.join(workspaceRoot, 'sessions');

  function formatDate(value = now()) {
    const date = new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  async function readMeta() {
    try {
      return JSON.parse(await fsImpl.readFile(path.join(sessionsRoot, 'meta.json'), 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {
          activeSessionId: null,
          dailyIncrement: {
            date: null,
            value: 0,
          },
        };
      }

      throw error;
    }
  }

  async function writeMeta(meta) {
    await fsImpl.mkdir(sessionsRoot, { recursive: true });
    await fsImpl.writeFile(
      path.join(sessionsRoot, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf8',
    );
  }

  function resolveSessionDir(sessionId) {
    const [datePart, leaf] = String(sessionId).split('/');
    return path.join(sessionsRoot, datePart, leaf);
  }

  async function readJsonl(filePath) {
    try {
      const content = await fsImpl.readFile(filePath, 'utf8');
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  async function writeJsonl(filePath, records) {
    const body = records.map((record) => JSON.stringify(record)).join('\n');
    await fsImpl.writeFile(filePath, body ? `${body}\n` : '', 'utf8');
  }

  async function readRequiredJsonl(filePath) {
    try {
      const content = await fsImpl.readFile(filePath, 'utf8');
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new Error(`Missing required session file: ${filePath}`);
      }

      throw error;
    }
  }

  function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  async function acquireMetaLock() {
    const lockPath = path.join(sessionsRoot, '.meta.lock');

    await fsImpl.mkdir(sessionsRoot, { recursive: true });
    while (true) {
      try {
        await fsImpl.mkdir(lockPath);
        return async () => {
          await fsImpl.rm(lockPath, { recursive: true, force: true });
        };
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          await new Promise((resolve) => setTimeout(resolve, SESSION_META_LOCK_RETRY_MS));
          continue;
        }

        throw error;
      }
    }
  }

  async function updateActiveSessionId(sessionId) {
    const release = await acquireMetaLock();
    try {
      const meta = await readMeta();
      await writeMeta({
        ...meta,
        activeSessionId: sessionId,
      });
    } finally {
      await release();
    }
  }

  async function createSession({ initialMessages = [] } = {}) {
    const release = await acquireMetaLock();
    let sessionId;

    try {
      const datePart = formatDate();
      const meta = await readMeta();
      const nextValue =
        meta.dailyIncrement.date === datePart ? meta.dailyIncrement.value + 1 : 1;

      sessionId = `${datePart}/${nextValue}-${randomUUID()}`;
      const sessionDir = resolveSessionDir(sessionId);

      await fsImpl.mkdir(path.join(sessionDir, 'message-before'), { recursive: true });
      await fsImpl.mkdir(path.join(sessionDir, 'artifacts'), { recursive: true });
      await fsImpl.mkdir(path.join(sessionDir, 'pending'), { recursive: true });
      await fsImpl.writeFile(path.join(sessionDir, 'history.jsonl'), '', 'utf8');
      await writeJsonl(
        path.join(sessionDir, 'message.jsonl'),
        initialMessages.map((message) => ({ turn: 0, message })),
      );

      await writeMeta({
        activeSessionId: sessionId,
        dailyIncrement: {
          date: datePart,
          value: nextValue,
        },
      });
    } finally {
      await release();
    }

    return {
      sessionId,
      messages: initialMessages,
      nextTurn: 1,
    };
  }

  async function listSessions() {
    try {
      const dates = (await fsImpl.readdir(sessionsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

      const sessionIds = [];
      for (const datePart of dates) {
        const leaves = (
          await fsImpl.readdir(path.join(sessionsRoot, datePart), { withFileTypes: true })
        )
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((left, right) => Number(left.split('-')[0]) - Number(right.split('-')[0]));

        for (const leaf of leaves) {
          sessionIds.push(`${datePart}/${leaf}`);
        }
      }

      return sessionIds;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  async function loadSession(sessionId) {
    const sessionDir = resolveSessionDir(sessionId);
    await recoverPendingCompression(sessionId);
    const entries = await readRequiredJsonl(path.join(sessionDir, 'message.jsonl'));
    const nextTurn =
      entries.length === 0 ? 1 : Math.max(...entries.map((entry) => entry.turn)) + 1;

    return {
      sessionId,
      messages: entries.map((entry) => entry.message),
      nextTurn,
    };
  }

  async function loadActiveSession() {
    const meta = await readMeta();
    if (!meta.activeSessionId) {
      return null;
    }

    return loadSession(meta.activeSessionId);
  }

  async function activateSession(sessionId) {
    await readRequiredJsonl(path.join(resolveSessionDir(sessionId), 'message.jsonl'));
    await updateActiveSessionId(sessionId);
    return loadSession(sessionId);
  }

  async function persistCompletedTurn({
    sessionId,
    turn,
    userMessage,
    assistantMessage,
    toolTrace = [],
  }) {
    const sessionDir = resolveSessionDir(sessionId);
    const messagePath = path.join(sessionDir, 'message.jsonl');
    const historyPath = path.join(sessionDir, 'history.jsonl');
    await fsImpl.access(historyPath);
    const existingEntries = await readRequiredJsonl(messagePath);
    const timestamp = new Date().toISOString();
    const toolPayloads = [];

    for (const trace of toolTrace) {
      const serializedResult = JSON.stringify(trace.result);
      const byteLength = Buffer.byteLength(serializedResult, 'utf8');

      if (byteLength > INLINE_TOOL_RESULT_LIMIT) {
        const artifactRef = path.join('artifacts', 'tool', `${turn}-${trace.callId}.json`);
        const summary = `${trace.toolName} result stored at ${artifactRef} (${byteLength} bytes)`;

        toolPayloads.push({
          artifactRef,
          artifactBody: serializedResult,
          messageEntry: {
            turn,
            message: {
              role: 'tool',
              toolName: trace.toolName,
              callId: trace.callId,
              content: JSON.stringify({ artifactRef, summary }),
            },
          },
          historyRecords: [
            {
              type: 'tool_call',
              turn,
              toolName: trace.toolName,
              callId: trace.callId,
              args: trace.args,
              timestamp,
            },
            {
              type: 'tool_result',
              turn,
              toolName: trace.toolName,
              callId: trace.callId,
              displaySummary: summary,
              artifactRef,
              timestamp,
            },
          ],
        });
      } else {
        toolPayloads.push({
          messageEntry: {
            turn,
            message: {
              role: 'tool',
              toolName: trace.toolName,
              callId: trace.callId,
              content: serializedResult,
            },
          },
          historyRecords: [
            {
              type: 'tool_call',
              turn,
              toolName: trace.toolName,
              callId: trace.callId,
              args: trace.args,
              timestamp,
            },
            {
              type: 'tool_result',
              turn,
              toolName: trace.toolName,
              callId: trace.callId,
              displaySummary: serializedResult,
              timestamp,
            },
          ],
        });
      }
    }

    const nextEntries = [
      ...existingEntries,
      { turn, message: userMessage },
      ...toolPayloads.map((payload) => payload.messageEntry),
      { turn, message: assistantMessage },
    ];

    const historyRecords = [
      {
        type: 'message',
        turn,
        role: userMessage.role,
        content: userMessage.content,
        timestamp,
      },
      ...toolPayloads.flatMap((payload) => payload.historyRecords),
      {
        type: 'message',
        turn,
        role: assistantMessage.role,
        content: assistantMessage.content,
        timestamp,
      },
    ];

    await fsImpl.mkdir(path.join(sessionDir, 'artifacts', 'tool'), { recursive: true });
    for (const payload of toolPayloads) {
      if (payload.artifactRef) {
        await fsImpl.writeFile(
          path.join(sessionDir, payload.artifactRef),
          payload.artifactBody,
          'utf8',
        );
      }
    }

    await writeJsonl(messagePath, nextEntries);
    await fsImpl.appendFile(
      historyPath,
      `${historyRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );

    return {
      messages: nextEntries.map((entry) => entry.message),
      nextTurn: turn + 1,
    };
  }

  async function applyCompression({
    sessionId,
    compressionId,
    appliedBeforeTurn,
    nextEntries,
    summary,
  }) {
    const sessionDir = resolveSessionDir(sessionId);
    const messagePath = path.join(sessionDir, 'message.jsonl');
    const beforeMessageRef = path.join('message-before', `${compressionId}.before.jsonl`);
    const beforePath = path.join(sessionDir, beforeMessageRef);
    const pendingPath = path.join(sessionDir, 'pending', 'compression.json');
    const nextBody = `${nextEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    const afterDigest = sha256(nextBody);

    await fsImpl.mkdir(path.dirname(beforePath), { recursive: true });
    await fsImpl.copyFile(messagePath, beforePath);
    await fsImpl.writeFile(`${messagePath}.tmp`, nextBody, 'utf8');
    await fsImpl.writeFile(
      pendingPath,
      JSON.stringify({
        sessionId,
        compressionId,
        appliedBeforeTurn,
        beforeMessageRef,
        summary,
        afterDigest,
      }),
      'utf8',
    );
    await fsImpl.rename(`${messagePath}.tmp`, messagePath);
    await fsImpl.appendFile(
      path.join(sessionDir, 'history.jsonl'),
      `${JSON.stringify({
        type: 'compression',
        sessionId,
        compressionId,
        appliedBeforeTurn,
        beforeMessageRef,
        summary,
        afterDigest,
        timestamp: new Date().toISOString(),
      })}\n`,
      'utf8',
    );
    await fsImpl.rm(pendingPath, { force: true });
  }

  async function recoverPendingCompression(sessionId) {
    const sessionDir = resolveSessionDir(sessionId);
    const pendingPath = path.join(sessionDir, 'pending', 'compression.json');

    let pending;
    try {
      pending = JSON.parse(await fsImpl.readFile(pendingPath, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return;
      }

      throw error;
    }

    if (pending.sessionId !== sessionId) {
      throw new Error(`Pending compression sessionId mismatch: ${pending.sessionId}`);
    }

    const messageBody = await fsImpl.readFile(path.join(sessionDir, 'message.jsonl'), 'utf8');
    const history = await readRequiredJsonl(path.join(sessionDir, 'history.jsonl'));
    const committed = history.some(
      (entry) => entry.type === 'compression' && entry.compressionId === pending.compressionId,
    );

    if (!committed && sha256(messageBody) === pending.afterDigest) {
      await fsImpl.appendFile(
        path.join(sessionDir, 'history.jsonl'),
        `${JSON.stringify({
          type: 'compression',
          sessionId,
          compressionId: pending.compressionId,
          appliedBeforeTurn: pending.appliedBeforeTurn,
          beforeMessageRef: pending.beforeMessageRef,
          summary: pending.summary,
          afterDigest: pending.afterDigest,
          timestamp: new Date().toISOString(),
        })}\n`,
        'utf8',
      );
    }

    await fsImpl.rm(pendingPath, { force: true });
  }

  async function forkSession({ sourceSessionId, targetTurn, newUserInput }) {
    const sourceDir = resolveSessionDir(sourceSessionId);
    const history = await readRequiredJsonl(path.join(sourceDir, 'history.jsonl'));
    const completedTurns = new Set(
      history
        .filter((entry) => entry.type === 'message' && entry.role === 'assistant')
        .map((entry) => entry.turn),
    );

    if (targetTurn !== 0 && !completedTurns.has(targetTurn)) {
      throw new Error(`Invalid fork target turn: ${targetTurn}`);
    }

    const laterCompression = history.find(
      (entry) => entry.type === 'compression' && entry.appliedBeforeTurn > targetTurn,
    );
    const baseEntries = await readRequiredJsonl(
      laterCompression
        ? path.join(sourceDir, laterCompression.beforeMessageRef)
        : path.join(sourceDir, 'message.jsonl'),
    );
    const slicedEntries = baseEntries.filter((entry) => entry.turn <= targetTurn);
    const forkTurn = targetTurn + 1;
    const forkedSession = await createSession({ initialMessages: [] });
    const forkDir = resolveSessionDir(forkedSession.sessionId);
    const forkEntries = [
      ...slicedEntries,
      {
        turn: forkTurn,
        message: {
          role: 'user',
          content: newUserInput,
        },
      },
    ];

    await writeJsonl(path.join(forkDir, 'message.jsonl'), forkEntries);

    const copiedHistory = history.filter((entry) => {
      if (entry.type === 'compression') {
        return entry.appliedBeforeTurn <= targetTurn;
      }

      return typeof entry.turn === 'number' ? entry.turn <= targetTurn : true;
    });
    copiedHistory.push({
      type: 'message',
      turn: forkTurn,
      role: 'user',
      content: newUserInput,
      timestamp: new Date().toISOString(),
    });
    await writeJsonl(path.join(forkDir, 'history.jsonl'), copiedHistory);

    const artifactRefs = [
      ...new Set(
        copiedHistory
          .filter((entry) => typeof entry.artifactRef === 'string' && entry.artifactRef !== '')
          .map((entry) => entry.artifactRef),
      ),
    ];
    for (const artifactRef of artifactRefs) {
      const sourceArtifactPath = path.join(sourceDir, artifactRef);
      const forkArtifactPath = path.join(forkDir, artifactRef);
      try {
        await fsImpl.mkdir(path.dirname(forkArtifactPath), { recursive: true });
        await fsImpl.copyFile(sourceArtifactPath, forkArtifactPath);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          throw new Error(`Missing required session file: ${sourceArtifactPath}`);
        }

        throw error;
      }
    }

    return {
      sessionId: forkedSession.sessionId,
      messages: forkEntries.map((entry) => entry.message),
      nextTurn: forkTurn,
    };
  }

  return {
    applyCompression,
    activateSession,
    createSession,
    forkSession,
    loadActiveSession,
    loadSession,
    listSessions,
    persistCompletedTurn,
    readMeta,
    recoverPendingCompression,
    resolveSessionDir,
  };
}

module.exports = {
  INLINE_TOOL_RESULT_LIMIT,
  createSessionStore,
};
