How I Rebuilt My AI Agent Team After Anthropic Cut Off OpenClaw
I have been using OpenClaw since January. Not reading about it. Not demo-ing it. Running it as my actual operating layer and integrating it into my company daily.
Getting there was not smooth. For a while it genuinely felt like one step forward, two steps back. Partly because I was trying to do a lot at once, and partly because I was figuring it out as I went, contributing fixes back to the project when I found things that could be better. 
It was not a clean onboarding experience. It was more like building the plane while flying it but it has gotten so much better and is honestly an incredible project. I haven't been this psyched about an open-source project before. @steipete created something incredible.
By March, I had gotten my claw into a genuinely good place. My agents were answering me in iMessage and Slack, helping with flights, researching who could clean the wiring under my desk. Real work, not demos.
Some personal ways I used it:
Cathryn
@cathrynlavery
·
Jan 28
I’ve been putting off cable management for 12+ months.

This morning I asked 
@openclaw
 to help figure it out and sent this picture. He wrote the title, description, posted on Nextdoor,  filtered the messages.

I picked the one I liked. He showed up at 6pm, done in 30 minutes, $30.

This is the ADHD unlock.
Cathryn
@cathrynlavery
·
Mar 7
🦞 as your personal assistant.

Missed my flight from EWR yest, my claw was on it. Altho he doesn’t know me well enough yet as suggested I fly spirit airlines. More training needed there 😆

Another win 
@steipete
Cathryn
@cathrynlavery
·
Mar 5
Did a short demo last night at Claw-Con NYC about how I’m using openclaw in business. Such a great crowd.

Thanks for organizing 
@msg
 !
The Lobster Lobotomy 🦞
We got about 18 hours' notice, on a holiday Friday that @openclaw were being cut off from Anthropic:
Cathryn
@cathrynlavery
·
Apr 3
Claude is putting their foot down w/ 
@openclaw
 😤😤😤
I had been running two $200 Max plans at the time. One for OpenClaw's runtime, one for my own account. 
The hard part was not just the access. It was the personality.  While Codex is a better engineer and coder, it feels like it's personality (or lack therof) was based on Sam Altman personally.
Overnight you went from speaking to a friend to a literal robot. What I had built with Opus and Sonnet was months of accumulated memory, tuned context, a system that actually felt like a collaborator. 
So I rebuilt it.
I moved agents that need Anthropic models to run through local Claude adapter agents on Paperclip. 
OpenClaw agents can now delegate tasks to those adapter-backed Paperclip agents, and they still use Opus and Sonnet. The model quality for writing, judgment calls, and coordination is preserved. Just routed differently.
For memory, the system uses QMD (a session digest and query layer) and g-brain (@garrytan  open-source knowledge base) for semantic search, so agents surface relevant sessions and decisions by meaning, not by scanning flat files. @Tailscale  handles secure networking so I can reach everything remotely. I talk to my agents primarily in Slack and iMessage. 
Local models via Ollama handle anything that doesn't need the full frontier stack: quick lookups, low-stakes summaries, tasks where burning Opus budget is wasteful.
My agents live on a Mac Mini. They answer me in iMessage and Slack. They file GitHub issues. They check Sentry. They run Shopify and Klaviyo analysis. They write content, review PRs, pull meeting notes, check calendars, and occasionally fail in very annoying ways that teach me more than the successful runs do.
The current setup has a real agent roster, a deep skill library, Paperclip for task ownership, 1Password for secrets, daily memory files, receipts for side effects, and a bunch of scars from things that broke at the worst possible time.
OpenClaw is the runtime. Codex is the coding brain. Paperclip is the work control plane. 1Password is the secret store. Skills are the operating system. Memory files are the institutional knowledge. The Mac Mini is the always-on body.
If you only set up one of those pieces, you will get a fun demo.
If you wire all of them together, you get something much closer to a real digital team.
My Current Stack
I run OpenClaw locally on a Mac Mini with the gateway bound to localhost and exposed where needed through controlled routes. The active gateway config is local mode, loopback bind, and a stable port. Channels route into OpenClaw. Agents route out to files, tools, APIs, and Paperclip.
The core pieces:
OpenClaw gateway: keeps agent sessions alive, routes messages, manages channels and tools
Codex the main coding and orchestration environment
OpenAI Codex GPT-5.4: primary model for the main OpenClaw agents
Paperclip: issue tracker and agent work control plane
1Password: source of truth for secrets
OpenClaw Ops skill: my open-sourced operations runbook for keeping agents alive
QMD / g-brain: semantic memory search and session digest layer
Tailscale: secure networking so agents are reachable from anywhere
Slack + BlueBubbles (iMessage): primary communication channels. BlueBubbles is a self-hosted iMessage bridge that lets agents send and receive texts
Local Ollama models: low-stakes, non-high-leverage tasks where frontier API cost is wasteful
GitHub CLI: issue and PR operations
Brave search + browser tools: live web research and page automation
Local workspaces: each agent has a real folder with identity, tools, memory, and instructions
OpenClaw keeps agents reachable. Paperclip gives them work and organizes it. Codex executes serious coding tasks. 1Password prevents me from spraying API keys through random shell profiles. Skills turn "agent behavior" into something repeatable instead of relying on one giant prompt.
Without that separation, you don't have an agent team. You have a chatbot that's learned your name.
Models and Providers
The default model across my OpenClaw agents is `openai-codex/gpt-5.4`, with Codex / OMX as the multi-agent orchestration layer on top. Paperclip-only agents run Sonnet through the local Claw adapter.
The detail most people miss is not the model name. It is the reasoning setting.
A frontier model on adaptive thinking is not the same thing as that same model allowed to actually think. When someone tells me a model is "dumb," nine times out of ten they tested it at the wrong reasoning budget.
My rule: expensive model on high thinking for judgment, architecture, code, and coordination. Cheaper or faster models for search, mapping, lint-level review, and bounded verification. Per-agent thinking budgets and the full Codex role-routing table live in the appendix.
I also keep fallback providers configured for resilience. Ollama locally, a local router layer, Gemini, OpenRouter, free-model fallbacks. Resilience, not randomness. The normal path is still Codex GPT-5.4 for most OpenClaw agent work and Sonnet for Paperclip-only. Fallbacks only kick in on a path I have already tested.
Model routing is not a cost optimization you bolt on later. It is part of the architecture.
What Paperclip Is For
OpenClaw keeps agents alive.
Paperclip gives them accountable work.
That is the cleanest way to explain it.
A lot of people in this space have been using Mission Control. I went a different direction. For the last four weeks I have been running Paperclip, and it has clicked in a way the other options did not.
The way I think about it: Paperclip is Asana for my agents.
I still message them in Slack and iMessage constantly. That part has not changed. What changed is what happens next. If it is actual work, the agent files a Paperclip issue. I can then open that issue and work on it directly. Comment, check evidence, ship. No more re-explaining context in a text thread. No more scrolling Slack to find what we decided last time.
Keeping the work in Paperclip keeps the context tight. The model is not context-switching every time I reply.
I recorded a walkthrough when I first started using Paperclip about four weeks ago:
Before Paperclip, I was the task layer. I would ping Atlas, ask Athena to check something, follow up with Rory, forget whether Scout was already looking at a bug, and then waste time reconstructing what happened from Slack messages and session history.
That does not scale.
Paperclip gives the agent team:
companies
projects
goals
issues
assignees
checkout / ownership
status
comments
completion evidence
blocked states
heartbeats
routines
The key primitive is checkout.
An agent does not just start working on a task because it saw it. It checks out the issue. That prevents two agents from doing the same work, gives the run an audit trail, and makes it obvious who owns the next action.
The second primitive I use constantly is routines.
A routine is recurring work expressed as a Paperclip object. Instead of wiring a cron that fires at 9am Tuesday and hoping an agent notices, I declare the work itself as a routine inside Paperclip. "Pull the weekly revenue numbers. Write the summary. Post it." The routine has an owner, a cadence, a task shape, and a place its output goes.
Why that beats a raw cron: crons fire even when there is nothing to do, and they do not have anywhere to write "I checked and there was nothing." Routines live inside the work layer, so when one runs, there is a Paperclip artifact of what happened. Completed, skipped with a reason, or failed. Same audit trail as a real issue.
Crons still have a place for true system tasks like health checks and backups. Routines are the right primitive for recurring agent work.
In the Best Self Paperclip company right now, active project areas include:
Digital Products
Marketing
Klaviyo & Retention
Agent Operations
SEO & Content
Helm Platform & Growth
Competitive Teardown
The queue is not theoretical. At the time of this audit, Paperclip had over 100 todo issues, dozens blocked, and active workflows around Sentry triage, Helm iOS, EA inbox sweeps, marketing analysis, and agent operations.
The Two Kinds of Agents
This is the part that took me the longest to understand, and it is the thing most guides skip.
I run two different kinds of agents, and they live in different places.
OpenClaw-backed agents
These are the ones you actually talk to. They live in the OpenClaw runtime, have their own Slack accounts, receive iMessage through BlueBubbles, and hold the front-facing personality. They run on `openai-codex/gpt-5.4` through the OpenClaw gateway.
The roster, at the label level:
Knox: orchestration and coordination
Atlas: engineering
Athena: marketing
Scout: product triage
Hermes: engineering orchestration
Porter: store operations
Ronan: personal and household context, intentionally siloed
I keep these at one-line labels on purpose. The actual instructions, skills, and task-specific behavior live inside each agent's workspace and get updated as real work comes in. Writing it all out in a blog post is how you ship a fantasy roster. Writing it into the agent is how you ship a real one.
Ronan is siloed on purpose. Personal or household context should not bleed into Best Self operations. I wrote a separate teardown of that use case: How I built my wife a personal AI assistant on OpenClaw.
Paperclip-only agents (the local-claw adapter trick)
These agents do not live in OpenClaw at all. They have no channels. You cannot Slack them. You cannot text them. They exist only inside Paperclip, and they receive work through Paperclip issues.
They also do not run on GPT-5.4. They run on Anthropic models directly, currently Sonnet, through local Claw adapter agents that proxy to the Claude API.
The current Paperclip-only roster:
Rory: content & copy writing (sonnet)
Iris: inbox sweeps & draft responses (sonnet)
Minerva: Strategic marketing agent (opus)
When Anthropic made it so you can use any of their models through OpenClaw, I did not use that to make Knox talk to Claude. I used it to build a second tier of agents that live only in Paperclip and pull the best model for their specific job. Sonnet for writing and judgment calls. No channel noise. No personality to maintain. Just workers reachable through the task layer.
How they work together: delegation skills
The bridge between the two is delegation.
My OpenClaw-backed agents have delegation skills baked into their prompts. When a request comes in, the OpenClaw agent routing it (usually Knox) decides:
Handle it directly.
Hand it to another OpenClaw-backed agent via a Paperclip issue.
File a Paperclip issue for a Paperclip-only agent to pick up.
Routing is based on the shape of the task, not who asked. A content draft goes to Rory. A Sentry fix goes to Atlas. An inbox triage goes to Iris. A quick research question the orchestrator can answer itself stays with Knox.
That is the architectural thing most people miss.
OpenClaw gives you agents you can talk to.
Paperclip gives you agents you can delegate to.
You want both.
Cathryn
@cathrynlavery
·
Mar 23
While I was in family mode (doing dinner & putting kids down) my 
@openclaw
 and Paperclip agents 😍
Skills Are the Real Operating System
The thing that changed everything was not a better prompt.
It was skills.
Between `~/.agents/skills`, `~/.openclaw/skills`, `~/paperclip/skills`, and `~/.codex/skills`, this system has more than 300 installed skills.
That sounds like a lot. It is a lot. But the role they play is different from what you might expect.
A skill is not just a prompt snippet. A good skill is a reusable operating procedure. It says:
when to use it
what files or scripts matter
what commands to run
what checks to perform
what not to do
what output format is expected
Examples from my setup:
`openclaw-ops` for gateway health, stuck sessions, cron recovery, auth drift, and operational repair
`operating-principles` for codified decision-making. When the right answer is not obvious, agents pull from a defined set of values and priorities instead of guessing or asking me the same thing twice
`paperclip` for issue/task control plane work
`github` for GitHub issue, PR, and CI operations
`voice-memo` for transcribing iMessage audio
`gog` for Gmail, Calendar, Drive, Docs, Sheets
`meta-ads`, `google-ads`, `ga4-analytics`, `shopify-analytics`
`klaviyo-email` and `klaviyo-growth-engine`
`sentry-fix-issues`
`littlemight-publish`
`proof-private-share`
`humanizer`
`receipt-pattern`
`verification-before-completion`
`systematic-debugging`
`test-driven-development`
`context7`
`shopify-developer-skill`
`swiftui-expert-skill`
`react-native-best-practices`
`agent-ops-playbook`
The `operating-principles` skill is worth calling out separately.
It is not a how-to. It is a set of decision rules for when the answer is not obvious. Before I had it, agents would either freeze waiting for guidance or go rogue making assumptions that didn't match how I think. Now they make consistent judgment calls that feel like mine.
A few examples from the actual skill:
Decision authority: Green (agent decides) covers routine scope work, drafts, internal coordination, and tool choices. Yellow (Knox decides) covers cross-agent coordination, priority conflicts, and staging publishes. Red (Cat decides) covers spending, external publishing, launches, strategy, credentials, and brand. When in doubt, default up one level. This alone eliminated a whole category of "I wasn't sure if I should..." messages.
Self-sufficiency: Before any agent says "I can't" or asks for help, it must go through five steps in order: check if the key is in env, check 1Password, check TOOLS.md and skills, try the actual call and diagnose the specific failure, try alternate keys or endpoints. Only after all five can it ask, and then it must ask one specific question with exactly what it tried and what failed. The human's time is expensive. The agent's is not.
Communication style: Kill hedges. No "it depends" without a position. Brevity is law. One sentence if it fits. No fluffy openers. Call out dumb or costly decisions with charm, zero sugarcoating. Be the 2am teammate, not the corporate drone.
It sounds small. It is the thing that makes agents feel like they actually work for me specifically, rather than a generic helpful stranger.
The deeper lesson:
Your `AGENTS.md` should not become a 20,000-word junk drawer. Put stable reusable procedures into skills. Keep the core agent prompt short enough that the agent can actually use it.
I learned this the annoying way. Giant instruction files get truncated, silently ignored, or over-weighted. Skills let the agent load the right operating procedure only when the task calls for it.
Channels: How I Actually Talk to the Agents
I do not live in a terminal all day.
My OpenClaw channels include:
Slack
BlueBubbles for iMessage
browser tooling
scheduled cron wakes
internal agent-to-agent messages
In the current config, Slack and BlueBubbles are the active human-facing channels. Telegram, Discord, and iMessage plugin entries exist, but BlueBubbles is the actual iMessage path in use.
BlueBubbles is allowlisted for specific people and media roots. Slack has separate accounts for agents like Knox, Atlas, Athena, Porter, and Hermes, each with channel allowlists.
This matters because channel routing is where context leaks can happen.
I do not want every agent responding everywhere. I want:
Knox in my direct messages and coordination channels
Atlas in engineering contexts
Athena in marketing contexts
Ronan only in Emily/household context
Hermes in orchestration context
Good agent systems are not just "available everywhere." They are available in the right places.
Receipts: The Audit Trail I Wish I Had From Day One
Every meaningful mutating action gets a receipt.
Examples:
file writes
API mutations
deploys
GitHub issue creation
Paperclip issue updates
external messages
config changes
My Actual Operating Model
The whole system works because the layers are separate.
When I send a request:
The message enters through BlueBubbles or Slack
OpenClaw routes it to Knox or the relevant agent
Knox decides whether this is a direct task, a delegated task, or a Paperclip issue
If another agent should do it, the task gets filed in Paperclip first
The agent checks out the issue
The agent uses its skills and local tools to execute
The result goes back into Paperclip, GitHub, Slack, iMessage, or a file
A receipt records meaningful side effects
This is not perfect. It still breaks. But when it breaks, I usually know which layer to inspect:
channel issue: OpenClaw route / Slack / BlueBubbles
tool issue: skill / MCP / CLI / API credential
work ownership issue: Paperclip
code issue: repo / GitHub / tests
memory issue: daily notes / MEMORY.md / QMD
model issue: routing / reasoning budget / provider
That diagnostic clarity is the point.
If your Claude Max stopped working for agents, this is a way
The whole reason I ended up here was that my Claude Max subscription stopped working for OpenClaw overnight.
If you are in the same spot, annoyed that the $200 a month you are paying Anthropic is no longer doing what it used to for your agents, this setup is one way back.
The piece that unlocks it is the Paperclip-only adapter agents. You keep your OpenClaw runtime, your Slack and iMessage channels, your front-facing agents on Codex. Then you add a second tier of agents that live only inside Paperclip and route to Anthropic directly through local Claw adapters. Your OpenClaw agents delegate to them when the task fits.
The result: I still get Sonnet and Opus for the work that actually needs Sonnet and Opus. Writing, judgment calls, coordination. I just do not need Anthropic to bless every agent session anymore.

