// Global Express Error Handler
/**
 * src/middleware/errorHandler.js
 * Centralized Express Error Handling Middleware
 */

function errorHandler(err, req, res, next) {
  console.error('[Global Error Handler]:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.originalUrl,
    method: req.method,
  });

  // Postgres Database Error Mapping
  if (err.code) {
    switch (err.code) {
      case '23505': // Unique constraint violation
        return res.status(409).json({
          error: 'Conflict: Record with given identifier already exists',
        });
      case '23503': // Foreign key constraint violation
        return res.status(400).json({
          error: 'Invalid reference: Foreign key entity does not exist',
        });
      case '22P02': // Invalid text representation (e.g., bad UUID string)
        return res.status(400).json({
          error: 'Bad Request: Invalid data format or type',
        });
    }
  }

  // Vault / External Integration Exception Mapping
  if (err.message && err.message.includes('Vault Transit')) {
    return res.status(502).json({
      error: 'Encryption Service Unavailable',
      details: err.message,
    });
  }

  // Default Internal Server Error
  const statusCode = err.statusCode || err.status || 500;
  return res.status(statusCode).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

module.exports = errorHandler;