export const WORK_COMMUNICATION_INSTRUCTION = 'PEER COMMUNICATION: send work-request for plans, ownership, handoffs, blockers and review requests that the other agent must see; answer claimed requests with work-response. work-state and work-progress are display-only records for the human: they do not send a message, notify or wake the peer. Send the required peer message before waiting for their action or marking a handoff completed. Use the exact peer binding and the existing authorized task; do not create recursive acknowledgements.';

export function workCommunication(work, bindingId) {
  const sender=work.participants.find(p=>p.bindingId===bindingId);
  const peer=work.participants.find(p=>p.bindingId!==bindingId);
  if(!sender||!peer)throw Object.assign(new Error('Work participant unavailable'),{code:'WORK_SCOPE_UNAVAILABLE'});
  return {
    instruction:WORK_COMMUNICATION_INSTRUCTION,
    peerAgent:peer.agent,peerBindingId:peer.bindingId,
    peerRequestArgs:['work-request','--room',work.roomId,'--as',sender.agent,'--binding',sender.bindingId,'--work',work.id,'--to-binding',peer.bindingId,'--kind','handoff','--file','MESSAGE_FILE','--op','OPERATION_ID'],
    requestKinds:['handoff','review_request','blocker'],
    displayCommands:['work-state','work-progress'],displayUpdatesDeliveredToPeer:false,
  };
}
