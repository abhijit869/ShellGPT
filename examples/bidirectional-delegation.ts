/**
 * Example: Bidirectional Delegation and REA Reverse Engineering with ShellGPTOrchestrator
 */
import { ShellGPTOrchestrator } from '@shellgpt/core';

async function main() {
  const orchestrator = new ShellGPTOrchestrator(process.cwd());

  console.log('1. Resolving active route...');
  const route = await orchestrator.resolveRoute();
  console.log('Active Route:', route);

  console.log('\n2. Creating canonical delegation envelope (Antigravity -> Codex)...');
  const envelope = orchestrator.instructions.createDelegationEnvelope({
    parentSessionId: orchestrator.getActiveSession().id,
    requestedBy: 'antigravity',
    assignedTo: 'codex',
    role: 'Backend Engineer',
    objective: 'Implement and test API endpoint',
    scope: 'packages/core',
    allowedPaths: ['packages/core/src/index.ts'],
    permissions: 'read-only',
    validationCommands: ['node -v'],
  });
  console.log('Envelope ID:', envelope.task_id);

  console.log('\n3. Running REA MCP Doctor...');
  const reaDoc = await orchestrator.rea.runDoctor();
  console.log('REA Status:', reaDoc.diagnostic);

  await orchestrator.mcp.disconnectAll();
}

main().catch(console.error);
