# Deploy Netlify Functions

Deploy serverless functions alongside your static site.

## Quick Start

```javascript
// netlify/functions/hello.js
exports.handler = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Hello World" })
  };
};
```

## References

- [Functions Documentation](https://docs.netlify.com/functions/overview/)
