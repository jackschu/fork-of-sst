// Note: 4 cases where a websocket connection might be closed
// 1. closed while waiting for response + idle longer than 10min => send keep-alive after 9min
// 2. closed while waiting for response + 2hr connection limit => a new connection will be used
// 3. closed while not waiting + idle longer than 10min => detect close callback and resend
// 4. closed while not waiting + 2hr connection limit => a new connection will be used

const WebSocket = require("ws");

// Set debugRequestId in ref b/c debugRequestId will be used in callback, need to do the
// useRef trick to let the callback access its current value.
let _ref = {
  ws: null,
  wsConnectedAt: 0,
  wsLastConnectError: null,
};

// a new connection will be created if current connection has established for the given lifespan
const CONNECTION_LIFESPAN = 1800000; // 30 minutes

exports.main = function (event, context, callback) {
  context.callbackWaitsForEmptyEventLoop = false;

  _ref.event = event;
  _ref.context = context;
  _ref.callback = callback;
  _ref.keepAliveTimer = null;
  _ref.debugRequestId = `${context.awsRequestId}-${Date.now()}`;

  // Case: Lambda first run, no websocket connection
  if (!_ref.ws) {
    connectAndSendMessage();
  }
  // Case: Lambda subsequent run, websocket connection EXCEEDED life span
  else if (Date.now() - _ref.wsConnectedAt >= CONNECTION_LIFESPAN) {
    disconnect();
    connectAndSendMessage();
  }
  // Case: Lambda subsequent run, websocket connection NOT exceeded life span
  else {
    sendMessage();
  }

  function connectAndSendMessage() {
    console.log("connectAndSendMessage()");
    _ref.ws = new WebSocket(process.env.SST_DEBUG_ENDPOINT);
    _ref.wsConnectedAt = Date.now();
    _ref.wsLastConnectError = null;

    _ref.ws.onopen = () => {
      console.log("ws.onopen");
      sendMessage();
    };

    _ref.ws.onclose = (e) => {
      // Note: review the 4 cases a connection could be closed:
      // 1. WILL NOT HAPPEN: b/c the connect is kept alive by keep-alive message
      // 2. WILL NOT HAPPEN: b/c a new connect is created, and existing connection is disconnected
      // 3. CAN HAPPEN: reconnect and resend message
      // 4. WILL NOT HAPPEN: b/c a new connect is created, and existing connection is disconnected
      console.log("ws.onclose", e.code, e.reason);

      // stop timer
      if (_ref.keepAliveTimer) {
        console.log("ws.onclose - stop keep alive timer", _ref.keepAliveTimer);
        clearTimeout(_ref.keepAliveTimer);
      }

      // reconnect
      if (
        _ref.wsLastConnectError.type === "error" &&
        _ref.wsLastConnectError.message.startsWith("getaddrinfo ENOTFOUND")
      ) {
        // Do not retry on ENOTFOUND.
        // ie. debug stack is removed and the websocket endpoint does not exist.
        _ref.ws = undefined;
      } else {
        connectAndSendMessage();
      }
    };

    _ref.ws.onmessage = (e) => {
      console.log("ws.onmessage", e.data);
      receiveMessage(e.data);
    };

    _ref.ws.onerror = (e) => {
      console.log("ws.onerror", e);
      _ref.wsLastConnectError = e;
    };
  }

  function disconnect() {
    console.log("disconnect()");
    _ref.ws.onopen = () => {
      console.log("ws.onopen (old connection)");
    };

    _ref.ws.onclose = (e) => {
      console.log("ws.onclose (old connection)", e.code, e.reason);
    };

    _ref.ws.onmessage = (e) => {
      console.log("ws.onmessage (old connection)", e);
    };

    _ref.ws.onerror = (e) => {
      console.log("ws.onerror (old connection)", e);
    };
    _ref.ws.close();
  }

  function sendMessage() {
    // Send message
    console.log("sendMessage() - send request");

    const { debugRequestId, context, event } = _ref;

    _ref.ws.send(
      JSON.stringify({
        action: "stub.lambdaRequest",
        debugRequestId,
        debugRequestTimeoutInMs: context.getRemainingTimeInMillis(),
        debugSrcPath: process.env.SST_DEBUG_SRC_PATH,
        debugSrcHandler: process.env.SST_DEBUG_SRC_HANDLER,
        event,
        // do not pass back:
        // - context.callbackWaitsForEmptyEventLoop (always set to false)
        context: {
          functionName: context.functionName,
          memoryLimitInMB: context.memoryLimitInMB,
          awsRequestId: context.awsRequestId,
        },
        env: constructEnvs(),
      })
    );

    // Start timer to send keep-alive message if still waiting for response after 9 minutes
    console.log("sendMessage() - start keep alive timer");
    _ref.keepAliveTimer = setTimeout(function () {
      _ref.ws.send(JSON.stringify({ action: "stub.keepAlive" }));
      console.log("sent keepAlive message");
    }, 540000);
  }

  function receiveMessage(data) {
    console.log("receiveMessage()");
    const { action, debugRequestId, responseData, responseError } = JSON.parse(
      data
    );

    // handle failed to send requests
    if (action === "server.failedToSendRequestDueToClientNotConnected") {
      throw new Error("Debug client not connected.");
    }
    if (action === "server.failedToSendRequestDueToUnknown") {
      throw new Error("Failed to send request to debug client.");
    }

    // handle invalid and expired response
    if (
      action !== "client.lambdaResponse" ||
      debugRequestId !== _ref.debugRequestId
    ) {
      console.log("receiveMessage() - discard response");
      return;
    }

    // stop timer
    if (_ref.keepAliveTimer) {
      console.log(
        "receiveMessage() - stop keep alive timer",
        _ref.keepAliveTimer
      );
      clearTimeout(_ref.keepAliveTimer);
    }

    // handle response error
    if (responseError) {
      throw deserializeError(responseError);
    }

    // handle response data
    _ref.callback(null, responseData);
  }
};

///////////////////////////////
// Util Functions
///////////////////////////////

function constructEnvs() {
  const envs = {};
  Object.keys(process.env)
    .filter(
      (key) =>
        ![
          // Include
          //
          //'AWS_REGION',
          //'AWS_DEFAULT_REGION',
          //'AWS_LAMBDA_FUNCTION_NAME',
          //'AWS_LAMBDA_FUNCTION_VERSION',
          //'AWS_ACCESS_KEY_ID',
          //'AWS_SECRET_ACCESS_KEY',
          //'AWS_SESSION_TOKEN',
          //
          // Exclude
          //
          "SST_DEBUG_ENDPOINT",
          "SST_DEBUG_SRC_HANDLER",
          "SST_DEBUG_SRC_PATH",
          "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
          "AWS_LAMBDA_LOG_GROUP_NAME",
          "AWS_LAMBDA_LOG_STREAM_NAME",
          "LD_LIBRARY_PATH",
          "LAMBDA_TASK_ROOT",
          "AWS_LAMBDA_RUNTIME_API",
          "AWS_EXECUTION_ENV",
          "AWS_XRAY_DAEMON_ADDRESS",
          "AWS_LAMBDA_INITIALIZATION_TYPE",
          "PATH",
          "PWD",
          "LAMBDA_RUNTIME_DIR",
          "LANG",
          "NODE_PATH",
          "TZ",
          "SHLVL",
          "_AWS_XRAY_DAEMON_ADDRESS",
          "_AWS_XRAY_DAEMON_PORT",
          "AWS_XRAY_CONTEXT_MISSING",
          "_HANDLER",
          "_X_AMZN_TRACE_ID",
        ].includes(key)
    )
    .forEach((key) => {
      envs[key] = process.env[key];
    });
  return envs;
}

///////////////////////////////
// Serialize Error Functions
//
// https://github.com/sindresorhus/serialize-error/blob/master/index.js
///////////////////////////////

const commonProperties = [
  { property: "name", enumerable: false },
  { property: "message", enumerable: false },
  { property: "stack", enumerable: false },
  { property: "code", enumerable: true },
];

const destroyCircular = ({ from, seen, to_, forceEnumerable }) => {
  const to = to_ || (Array.isArray(from) ? [] : {});

  seen.push(from);

  for (const [key, value] of Object.entries(from)) {
    if (typeof value === "function") {
      continue;
    }

    if (!value || typeof value !== "object") {
      to[key] = value;
      continue;
    }

    if (!seen.includes(from[key])) {
      to[key] = destroyCircular({
        from: from[key],
        seen: seen.slice(),
        forceEnumerable,
      });
      continue;
    }

    to[key] = "[Circular]";
  }

  for (const { property, enumerable } of commonProperties) {
    if (typeof from[property] === "string") {
      Object.defineProperty(to, property, {
        value: from[property],
        enumerable: forceEnumerable ? true : enumerable,
        configurable: true,
        writable: true,
      });
    }
  }

  return to;
};

const deserializeError = (value) => {
  if (value instanceof Error) {
    return value;
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const newError = new Error();
    destroyCircular({ from: value, seen: [], to_: newError });
    return newError;
  }

  return value;
};
