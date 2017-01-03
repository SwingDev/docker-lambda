// Just a test lambda, run with:
// docker run -v "$PWD":/var/task lambci/lambda:api-gateway

exports.handler = function(event, context, cb) {
  context.success({
    statusCode: 200,
    body: JSON.stringify({status: 'ok'}),
    headers: {
      'Content-Type': 'application/json'
    }
  });

  return cb();
}