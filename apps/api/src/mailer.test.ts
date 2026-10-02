import { describe, expect, it } from 'vitest'
import { EmailNotSent, type EmailSender, sendSignInCodeWith } from './mailer.js'

type Message = Parameters<EmailSender['send']>[0]

function fakeSender(error: { name: string; message: string } | null = null) {
  const sent: Message[] = []
  const sender: EmailSender = {
    send: async (message) => {
      sent.push(message)
      return { error }
    },
  }
  return { sender, sent }
}

describe('sendSignInCodeWith', () => {
  it('sends the code to the address from the configured sender', async () => {
    const { sender, sent } = fakeSender()
    await sendSignInCodeWith(sender, 'AgentTrace <login@agenttrace.example>')(
      'op@example.com',
      '482913',
    )

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      from: 'AgentTrace <login@agenttrace.example>',
      to: 'op@example.com',
    })
    expect(sent[0]?.text).toContain('482913')
    expect(sent[0]?.subject).not.toContain('482913')
  })

  it('fails loudly when Resend refuses instead of pretending it sent', async () => {
    const { sender } = fakeSender({
      name: 'validation_error',
      message: 'You can only send testing emails to your own email address',
    })

    await expect(
      sendSignInCodeWith(sender, 'onboarding@resend.dev')('op@example.com', '482913'),
    ).rejects.toThrow(EmailNotSent)
  })

  it('keeps the code and the address out of the failure', async () => {
    // The failure goes to the logs; the code in a log line is a working
    // credential for five minutes, and the address is somebody's identity.
    const { sender } = fakeSender({
      name: 'validation_error',
      message: 'Invalid `to` field: op@example.com',
    })
    const failure = await sendSignInCodeWith(sender, 'x@example.com')(
      'op@example.com',
      '482913',
    ).catch((cause: unknown) => cause)

    expect(String(failure)).toContain('validation_error')
    expect(String(failure)).not.toContain('482913')
    expect(String(failure)).not.toContain('op@example.com')
  })
})
