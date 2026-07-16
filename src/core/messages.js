function createMessage(role, content, extras = {}) {
  return {
    role,
    content,
    ...extras,
  };
}

function createToolMessage(toolName, content, callId) {
  return createMessage('tool', content, {
    toolName,
    callId,
  });
}

module.exports = {
  createMessage,
  createToolMessage,
};

