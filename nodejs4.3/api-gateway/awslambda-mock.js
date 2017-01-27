var crypto = require('crypto')
var http = require('http')

var FN_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME || 'test'
var VERSION = process.env.AWS_LAMBDA_FUNCTION_VERSION || '$LATEST'
var MEM_SIZE = process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || 1536
var TIMEOUT = process.env.AWS_LAMBDA_FUNCTION_TIMEOUT || 300
var REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
var ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || randomAccountId()
var ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'SOME_ACCESS_KEY_ID'
var SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'SOME_SECRET_ACCESS_KEY'
var SESSION_TOKEN = process.env.AWS_SESSION_TOKEN

function consoleLog(str) {
  process.stderr.write(formatConsole(str))
}

function systemLog(str) {
  process.stderr.write(formatSystem(str) + '\n')
}

function systemErr(str) {
  process.stderr.write(formatErr(str) + '\n')
}

// Don't think this can be done in the Docker image
process.umask(2)

process.env.AWS_LAMBDA_FUNCTION_NAME = FN_NAME
process.env.AWS_LAMBDA_FUNCTION_VERSION = VERSION
process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = MEM_SIZE
process.env.AWS_LAMBDA_LOG_GROUP_NAME = '/aws/lambda/' + FN_NAME
process.env.AWS_LAMBDA_LOG_STREAM_NAME = new Date().toISOString().slice(0, 10).replace(/-/g, '/') +
  '/[' + VERSION + ']' + crypto.randomBytes(16).toString('hex')
process.env.AWS_REGION = REGION
process.env.AWS_DEFAULT_REGION = REGION

var baseContext = {
  initInvokeId: uuid(),
  suppressInit: true,
  handler: process.env.HANDLER || "index.handler",
  credentials: {
    key: ACCESS_KEY_ID,
    secret: SECRET_ACCESS_KEY,
    session: SESSION_TOKEN,
  },
  contextObjects: {},
  invokedFunctionArn: arn(REGION, ACCOUNT_ID, FN_NAME),
}

var startTimes = {}
var responses = {}

function respondWithStatus(invokeId, status, content, headers) {
  var res = responses[invokeId]

  res.writeHeader(status, headers || {})
  res.end(content || "")

  delete responses[invokeId];
}

var queue = []
function createServer() {
  function handleRequest(request, response) {
    var invokeId = uuid()
    var parsedUrl = require('url').parse(request.url, true)

    var body = []
    request.on('data', function(chunk) {
      body.push(chunk)
    }).on('end', function() {
      var context = Object.assign({
        invokeid: invokeId,
        eventBody: JSON.stringify({
          resource: "/{proxy+}",
          path: parsedUrl.pathname,
          pathParameters: {
            proxy: parsedUrl.pathname.slice(1)
          },
          httpMethod: request.method,
          queryStringParameters: Object.keys(parsedUrl.query).length > 0 ? parsedUrl.query : null,
          headers: request.headers,
          body: Buffer.concat(body).toString(),
          isBase64Encoded: false
        }),
      }, baseContext)

      if (process.env.QUEUE_LIMIT && queue.length > process.env.QUEUE_LIMIT) {
        response.writeHeader(502, {});
        response.end("");

        return;
      }

      responses[invokeId] = response

      queue.push(context)
      dequeueAndRunIfFree()
    })
  }

  var server = http.createServer(handleRequest)

  const PORT = process.env.PORT || 8080
  server.listen(PORT, function(){
    console.log("Server listening on: http://localhost:%s", PORT)
  })

  process.on('SIGINT', function() {
    console.log("Caught interrupt signal");
    process.exit();
  });
}

function dequeueAndRunIfFree() {
  if (!invokeFn) return;

  var context = queue.shift();
  if (!context) return;

  startTimes[context.invokeid] = process.hrtime()
  systemLog('START RequestId: ' + context.invokeid + ' Version: ' + VERSION)

  invokeFn(context)
  invokeFn = null
}

module.exports = {
  initRuntime: function() { createServer(); return baseContext; },
  waitForInvoke: function(fn) {
    invokeFn = fn;

    dequeueAndRunIfFree()
  },
  reportRunning: function(invokeId) {}, // eslint-disable-line no-unused-vars
  reportDone: function(invokeId, errType, resultStr) {
    if (invokeId === baseContext.initInvokeId) { return }

    if (typeof resultStr == 'string') {
      var opts = JSON.parse(resultStr);
      respondWithStatus(invokeId, opts.statusCode, opts.body, opts.headers);
    } else {
      respondWithStatus(invokeId, 500, errType);
    }

    var diffMs = hrTimeMs(process.hrtime(startTimes[invokeId]))
    var billedMs = Math.min(100 * (Math.floor(diffMs / 100) + 1), TIMEOUT * 1000)
    systemLog('END RequestId: ' + invokeId)
    systemLog([
      'REPORT RequestId: ' + invokeId,
      'Duration: ' + diffMs.toFixed(2) + ' ms',
      'Billed Duration: ' + billedMs + ' ms',
      'Memory Size: ' + MEM_SIZE + ' MB',
      'Max Memory Used: ' + Math.round(process.memoryUsage().rss / (1024 * 1024)) + ' MB',
      '',
    ].join('\t'))
    delete startTimes[invokeId]
  },
  reportFault: function(invokeId, msg, errName, errStack) {
    systemErr(msg + (errName ? ': ' + errName : ''))
    if (errStack) systemErr(errStack)

    delete startTimes[invokeId]
    respondWithStatus(invokeId, 500, "", {})
  },
  getRemainingTime: function() {
    return (TIMEOUT * 1000)
  },
  sendConsoleLogs: consoleLog,
  maxLoggerErrorSize: 256 * 1024,
}

function formatConsole(str) {
  return str.replace(/^[0-9TZ:\.\-]+\t[0-9a-f\-]+\t/, '\033[34m$&\u001b[0m')
}

function formatSystem(str) {
  return '\033[32m' + str + '\033[0m'
}

function formatErr(str) {
  return '\033[31m' + str + '\033[0m'
}

function hrTimeMs(hrtime) {
  return (hrtime[0] * 1e9 + hrtime[1]) / 1e6
}

// Approximates the look of a v1 UUID
function uuid() {
  return crypto.randomBytes(4).toString('hex') + '-' +
    crypto.randomBytes(2).toString('hex') + '-' +
    crypto.randomBytes(2).toString('hex').replace(/^./, '1') + '-' +
    crypto.randomBytes(2).toString('hex') + '-' +
    crypto.randomBytes(6).toString('hex')
}

function randomAccountId() {
  return String(0x100000000 * Math.random())
}

function arn(region, accountId, fnName) {
  return 'arn:aws:lambda:' + region + ':' + accountId.replace(/[^\d]/g, '') + ':function:' + fnName
}

