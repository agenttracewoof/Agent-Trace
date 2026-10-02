/** Delivers a one-time sign-in code (FR-018). */
export type SendSignInCode = (to: string, code: string) => Promise<void>

/** The slice of the Resend client this module uses — `new Resend(key).emails` fits it. */
export interface EmailSender {
  send(message: {
    from: string
    to: string
    subject: string
    text: string
  }): Promise<{ error: { name: string; message: string } | null }>
}

export class EmailNotSent extends Error {
  constructor(reason: string) {
    super(`Sign-in code was not sent: ${reason}`)
    this.name = 'EmailNotSent'
  }
}

export const CODE_TTL_MINUTES = 5

/**
 * Resend reports a refusal in the result instead of throwing, so a send that
 * did not happen would otherwise look like one that did — and the operator
 * would wait for a code that is never coming. Only the error's name is kept:
 * Resend's message can quote the recipient, and this ends up in the logs.
 */
export function sendSignInCodeWith(sender: EmailSender, from: string): SendSignInCode {
  return async (to, code) => {
    const { error } = await sender.send({
      from,
      to,
      subject: 'Your AgentTrace sign-in code',
      text: [
        `Your sign-in code is ${code}.`,
        `It expires in ${CODE_TTL_MINUTES} minutes and works once.`,
        '',
        'If you did not ask for it, ignore this email: nobody can sign in without the code.',
      ].join('\n'),
    })
    if (error !== null) throw new EmailNotSent(error.name)
  }
}
