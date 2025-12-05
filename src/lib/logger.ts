import winston, { Logger } from "winston"

function createLogger(level: string, serviceName: string): Logger {
  const logger = winston.createLogger({
    level: level,
    defaultMeta: {
      service: serviceName,
    },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp(),
          winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level}]: ${message}`
          })
        ),
      }),
      new winston.transports.File({
        format: winston.format.combine(winston.format.json(), winston.format.timestamp()),
        filename: "logs/combined.log",
      }),
      new winston.transports.File({
        format: winston.format.combine(winston.format.json(), winston.format.timestamp()),
        filename: "logs/error.log",
        level: "error",
      }),
    ],
  })

  return logger
}

export { createLogger }
