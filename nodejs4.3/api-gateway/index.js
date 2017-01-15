// Just a test lambda, run with:
// docker run --rm -v "$PWD":/var/task -p 80:8000 lambci/lambda:api-gateway

exports.handler = function(event, context) {
  context.succeed({
    statusCode: 200,
    body: JSON.stringify({status: 'ok'}),
    headers: {
      'Content-Type': 'application/json'
    }
  });
}