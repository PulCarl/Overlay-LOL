'use strict';

/*
 * Agents et maps de VALORANT, avec les adresses de leurs images.
 * Les noms et les images viennent de valorant-api.com, une API communautaire sans clé
 * (les illustrations appartiennent à Riot Games). Cette liste est embarquée pour que le panneau
 * fonctionne hors connexion ; le serveur la complète au démarrage avec les nouveautés.
 */

const MEDIA = 'https://media.valorant-api.com';

const AGENTS = [
  { id: '41fb69c1-4189-7b37-f117-bcaf1e96f1bf', name: 'Astra', role: 'Contrôleur' },
  { id: '5f8d3a7f-467b-97f3-062c-13acf203c006', name: 'Breach', role: 'Initiateur' },
  { id: '9f0d8ba9-4140-b941-57d3-a7ad57c6b417', name: 'Brimstone', role: 'Contrôleur' },
  { id: '22697a3d-45bf-8dd7-4fec-84a9e28c69d7', name: 'Chamber', role: 'Sentinelle' },
  { id: '1dbf2edd-4729-0984-3115-daa5eed44993', name: 'Clove', role: 'Contrôleur' },
  { id: '117ed9e3-49f3-6512-3ccf-0cada7e3823b', name: 'Cypher', role: 'Sentinelle' },
  { id: 'cc8b64c8-4b25-4ff9-6e7f-37b4da43d235', name: 'Deadlock', role: 'Sentinelle' },
  { id: 'dade69b4-4f5a-8528-247b-219e5a1facd6', name: 'Fade', role: 'Initiateur' },
  { id: 'e370fa57-4757-3604-3648-499e1f642d3f', name: 'Gekko', role: 'Initiateur' },
  { id: '95b78ed7-4637-86d9-7e41-71ba8c293152', name: 'Harbor', role: 'Contrôleur' },
  { id: '0e38b510-41a8-5780-5e8f-568b2a4f2d6c', name: 'Iso', role: 'Duelliste' },
  { id: 'add6443a-41bd-e414-f6ad-e58d267f4e95', name: 'Jett', role: 'Duelliste' },
  { id: '601dbbe7-43ce-be57-2a40-4abd24953621', name: 'KAY/O', role: 'Initiateur' },
  { id: '1e58de9c-4950-5125-93e9-a0aee9f98746', name: 'Killjoy', role: 'Sentinelle' },
  { id: '7c8a4701-4de6-9355-b254-e09bc2a34b72', name: 'Miks', role: 'Contrôleur' },
  { id: 'bb2a4828-46eb-8cd1-e765-15848195d751', name: 'Neon', role: 'Duelliste' },
  { id: '8e253930-4c05-31dd-1b6c-968525494517', name: 'Omen', role: 'Contrôleur' },
  { id: 'eb93336a-449b-9c1b-0a54-a891f7921d69', name: 'Phoenix', role: 'Duelliste' },
  { id: 'f94c3b30-42be-e959-889c-5aa313dba261', name: 'Raze', role: 'Duelliste' },
  { id: 'a3bfb853-43b2-7238-a4f1-ad90e9e46bcc', name: 'Reyna', role: 'Duelliste' },
  { id: '569fdd95-4d10-43ab-ca70-79becc718b46', name: 'Sage', role: 'Sentinelle' },
  { id: '6f2a04ca-43e0-be17-7f36-b3908627744d', name: 'Skye', role: 'Initiateur' },
  { id: '320b2a48-4d9b-a075-30f1-1f93a9b638fa', name: 'Sova', role: 'Initiateur' },
  { id: 'b444168c-4e35-8076-db47-ef9bf368f384', name: 'Tejo', role: 'Initiateur' },
  { id: '92eeef5d-43b5-1d4a-8d03-b3927a09034b', name: 'Veto', role: 'Sentinelle' },
  { id: '707eab51-4836-f488-046a-cda6bf494859', name: 'Viper', role: 'Contrôleur' },
  { id: 'efba5359-4016-a1e5-7626-b1ae76895940', name: 'Vyse', role: 'Sentinelle' },
  { id: 'df1cb487-4902-002e-5c17-d28e83e78588', name: 'Waylay', role: 'Duelliste' },
  { id: '7f94d92c-4234-0a36-9646-3a87eb8b5c89', name: 'Yoru', role: 'Duelliste' },
];

const MAPS = [
  { id: '224b0a95-48b9-f703-1bd8-67aca101a61f', name: 'Abyss' },
  { id: '7eaecc1b-4337-bbf6-6ab9-04b8f06b3319', name: 'Ascent' },
  { id: '2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba', name: 'Bind' },
  { id: '2fb9a4fd-47b8-4e7d-a969-74b4046ebd53', name: 'Breeze' },
  { id: '1c18ab1f-420d-0d8b-71d0-77ad3c439115', name: 'Corrode' },
  { id: 'b529448b-4d60-346e-e89e-00a4c527a405', name: 'Fracture' },
  { id: '2bee0dc9-4ffe-519b-1cbd-7fbe763a6047', name: 'Haven' },
  { id: 'e2ad5c54-4114-a870-9641-8ea21279579a', name: 'Icebox' },
  { id: '2fe4ed3a-450a-948b-6d6b-e89a78e680a9', name: 'Lotus' },
  { id: 'fd267378-4d1d-484f-ff52-77821ed10dc2', name: 'Pearl' },
  { id: 'd960549e-485c-e861-8d71-aa9d1aed12a2', name: 'Split' },
  { id: '756da597-416b-c0f2-f47b-afbdf28670bc', name: 'Summit' },
  { id: '92584fbe-486a-b1b2-9faa-39b0f486b498', name: 'Sunset' },
];

// Petit visage pour les lignes de joueurs, grand portrait pour la carte du MVP, bandeau pour les maps.
const agentIcon = (id) => `${MEDIA}/agents/${id}/killfeedportrait.png`;
const agentPortrait = (id) => `${MEDIA}/agents/${id}/fullportrait.png`;
const mapThumb = (id) => `${MEDIA}/maps/${id}/listviewicon.png`;

/* La liste que les pages reçoivent : chaque entrée porte directement ses adresses d'images. */
function publicCatalog(agents = AGENTS, maps = MAPS) {
  return {
    agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role, icon: agentIcon(a.id), portrait: agentPortrait(a.id) })),
    maps: maps.map((m) => ({ id: m.id, name: m.name, thumb: mapThumb(m.id) })),
  };
}

module.exports = { AGENTS, MAPS, MEDIA, agentIcon, agentPortrait, mapThumb, publicCatalog };
