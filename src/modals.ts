import type { ModalView } from "@slack/bolt";

// The "new call" modal. Deliberately loose rather than prescriptive: no
// forced format picker, no pre-enumerated options list. Question and
// criteria are the only two required fields; picks are free text, either
// entered by the creator (proxy mode, for when you're going round the
// room) or left for the channel to fill in themselves.
//
// Slack's block system can't conditionally show/hide blocks without a
// round trip, so proxy rows are rendered directly into the view and grown
// by re-calling this builder with a larger `proxyRowCount` in response to
// the "add person" button (see handlers/actions.ts).

export const NEW_CALL_CALLBACK_ID = "new_call_submit";
const DEFAULT_PROXY_ROWS = 3;

interface NewCallModalState {
  channelId: string;
  entryMode: "proxy" | "channel";
  proxyRowCount: number;
}

export function buildNewCallModal(state: NewCallModalState): ModalView {
  const { channelId, entryMode, proxyRowCount } = state;

  const proxyRowBlocks =
    entryMode === "proxy"
      ? Array.from({ length: proxyRowCount }, (_, i) => proxyRowBlock(i)).flat()
      : [];

  return {
    type: "modal",
    callback_id: NEW_CALL_CALLBACK_ID,
    private_metadata: JSON.stringify({ channelId, entryMode, proxyRowCount }),
    title: { type: "plain_text", text: "New call" },
    submit: { type: "plain_text", text: "Create call" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "question",
        label: { type: "plain_text", text: "What's the call?" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          placeholder: { type: "plain_text", text: "Will we ship by Friday?" },
        },
      },
      {
        type: "actions",
        block_id: "entry_mode_toggle",
        elements: [
          {
            type: "button",
            action_id: "entry_mode_proxy",
            text: { type: "plain_text", text: "I'll enter picks" },
            style: entryMode === "proxy" ? "primary" : undefined,
          },
          {
            type: "button",
            action_id: "entry_mode_channel",
            text: { type: "plain_text", text: "Post to channel" },
            style: entryMode === "channel" ? "primary" : undefined,
          },
        ],
      },
      ...(entryMode === "proxy"
        ? [
            {
              type: "context" as const,
              elements: [
                {
                  type: "mrkdwn" as const,
                  text: "Names resolve against the workspace. Anyone else can still add their own call later, until it locks.",
                },
              ],
            },
            ...proxyRowBlocks,
            {
              type: "actions" as const,
              block_id: "add_proxy_row",
              elements: [
                {
                  type: "button" as const,
                  action_id: "add_proxy_row",
                  text: { type: "plain_text" as const, text: "+ Add person" },
                },
              ],
            },
          ]
        : [
            {
              type: "context" as const,
              elements: [
                {
                  type: "mrkdwn" as const,
                  text: "Calledit posts the question. Anyone in the channel replies with their own call, in their own words.",
                },
              ],
            },
          ]),
      {
        type: "input",
        block_id: "reviewer",
        optional: true,
        label: { type: "plain_text", text: "Reviewer (optional)" },
        element: {
          type: "users_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Defaults to you" },
        },
      },
      {
        type: "input",
        block_id: "criteria",
        label: { type: "plain_text", text: "Criteria" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Stripe customers, 31 Aug" },
        },
      },
      {
        type: "input",
        block_id: "closes_at",
        label: { type: "plain_text", text: "Closes" },
        element: {
          type: "datetimepicker",
          action_id: "value",
        },
      },
      {
        type: "input",
        block_id: "visibility",
        label: { type: "plain_text", text: "Predictions" },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: {
            text: { type: "plain_text", text: "Sealed until close" },
            value: "sealed_until_close",
          },
          options: [
            {
              text: { type: "plain_text", text: "Sealed until close" },
              value: "sealed_until_close",
            },
            { text: { type: "plain_text", text: "Open" }, value: "open" },
            {
              text: { type: "plain_text", text: "Sealed until result" },
              value: "sealed_until_result",
            },
          ],
        },
      },
      {
        type: "input",
        block_id: "winnings",
        label: { type: "plain_text", text: "Winnings" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: "Bragging rights",
        },
      },
    ],
  };
}

function proxyRowBlock(index: number) {
  return [
    {
      type: "input" as const,
      block_id: `proxy_person_${index}`,
      optional: index >= 1, // first row required, the rest can stay blank
      label: { type: "plain_text" as const, text: `Person ${index + 1}` },
      element: {
        type: "users_select" as const,
        action_id: "value",
      },
    },
    {
      type: "input" as const,
      block_id: `proxy_value_${index}`,
      optional: index >= 1,
      label: { type: "plain_text" as const, text: "Their call" },
      element: {
        type: "plain_text_input" as const,
        action_id: "value",
      },
    },
  ];
}

export function nextProxyRowCount(currentCount: number): number {
  // Slack modals cap at 100 blocks; well below that in practice, but worth
  // a ceiling so a runaway click can't break the view.
  return Math.min(currentCount + 1, 20);
}

// -- Resolve modal --------------------------------------------------------

export const RESOLVE_CALLBACK_ID = "resolve_call_submit";

export function buildResolveModal(callId: string, question: string): ModalView {
  return {
    type: "modal",
    callback_id: RESOLVE_CALLBACK_ID,
    private_metadata: JSON.stringify({ callId }),
    title: { type: "plain_text", text: "Settle call" },
    submit: { type: "plain_text", text: "Settle" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${question}*` },
      },
      {
        type: "input",
        block_id: "result",
        label: { type: "plain_text", text: "Result" },
        element: { type: "plain_text_input", action_id: "value", multiline: true },
      },
      {
        type: "input",
        block_id: "evidence",
        optional: true,
        label: { type: "plain_text", text: "Evidence" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "A link, a screenshot, a quote" },
        },
      },
    ],
  };
}
