import {createService} from './service.mjs';
import {PROJECT_ID} from './photon.mjs';
import {createPhotonTransport,PHOTON_LIVE_TRANSPORT_ALLOWED} from './photon-transport.mjs';
import {logTransportDiagnostic} from './diagnostics.mjs';

// Observed in Athena's Users page on 2026-10-14. The displayed managed number is
// +17739371532; the SDK shared-pool routing value is the literal 'shared'.
const VERIFIED_OWNER_ADDRESS='+13322179242';

// Dependency injection is only for local fixtures. server.mjs supplies env only;
// no environment variable, HTTP argument or MCP tool selects these dependencies.
export function createRuntimeService(env,{now=Date.now,jwks,postCallback,
 transportFactory=createPhotonTransport,transportAllowed=PHOTON_LIVE_TRANSPORT_ALLOWED}={}) {
 const expiresAt=env.QUICKSILVER_SESSION_EXPIRES_AT,deadline=Date.parse(expiresAt),started=now();
 const ownerSubject=env.QUICKSILVER_OWNER_SUBJECT,projectSecret=env.SPECTRUM_PROJECT_SECRET;
 const configured=env.PHOTON_OWNER_ADDRESS===VERIFIED_OWNER_ADDRESS &&
  typeof projectSecret==='string' && projectSecret.trim().length>0 &&
  typeof ownerSubject==='string' && /^google-oauth2\|.+$/.test(ownerSubject) &&
  Number.isFinite(deadline) && deadline>started && deadline<=started+3600_000;
 // This canonical DM is derived, not a claim of an observed live chat GUID.
 // Both transport and controller reject incoming events with any other GUID.
 const photon=configured?Object.freeze({projectId:PROJECT_ID,ownerAddress:VERIFIED_OWNER_ADDRESS,
  line:'shared',dm:`any;-;${VERIFIED_OWNER_ADDRESS}`}):undefined;
 // Construction does not connect; only the authenticated boot-bound arm does.
 const photonTransport=configured && transportAllowed===true?
  transportFactory({config:photon,projectSecret,expiresAt,now,onDiagnostic:logTransportDiagnostic}):undefined;
 return createService({
  issuer:'https://dev-ar7fhtveuwv8gobu.us.auth0.com/',
  resource:'https://quicksilver-kvt8.onrender.com/mcp',
  clientId:'tpc_caXSmFzUtRmg6MaouZ9Dij',
  ownerSubject,expiresAt,now,jwks,postCallback,photon,photonTransport,
 });
}
