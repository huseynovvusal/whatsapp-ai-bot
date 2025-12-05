declare module "qrcode-terminal" {
  interface GenerateOptions {
    small?: boolean
  }

  function generate(
    text: string,
    options?: GenerateOptions,
    callback?: (qrcode: string) => void
  ): void
  function setErrorLevel(level: string): void
}
