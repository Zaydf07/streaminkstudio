const serverless = require('serverless-http');
const app = require('../../server');

const handler = serverless(app, {
  request(req, event) {
    // Netlify passes the original path in event.path
    // Make sure Express sees the correct URL
    req.url = event.path + (event.rawQuery ? '?' + event.rawQuery : '');
  }
});

exports.handler = handler;
