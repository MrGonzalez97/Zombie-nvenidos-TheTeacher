"use strict";
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {WebSocketServer,WebSocket}=require('ws');
const ROOT=__dirname,PORT=Number(process.env.PORT||3000),rooms=new Map(),sessions=new Map();
const MAX=4;
// Todas las acciones llegan a este proceso por el bucle de eventos de Node.
// Se aceptan en orden de recepción del servidor, con condición de valor anterior.
const ALLOWED_PATHS=new Set(['ds','loot','searched','homes','police','shopLoot','parkingBins','dropped','fires','cars','burned','station','parking','shop','throwables']);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function at(root,path){let node=root;for(const key of path){if(!node||typeof node!=='object'||!own(node,key))return undefined;node=node[key]}return node}
function commitPatch(room,patch){
 const path=patch?.path;
 if(!Array.isArray(path)||path.length<1||path.length>9||!ALLOWED_PATHS.has(path[0]))return {ok:false,reason:'Ruta inválida'};
 for(const key of path)if(!(typeof key==='string'&&key.length<=64&&key!=='__proto__'&&key!=='prototype'&&key!=='constructor'||Number.isInteger(key)&&key>=0&&key<100000))return {ok:false,reason:'Ruta inválida'};
 let parent=room.world;
 for(let i=0;i<path.length-1;i++){
  if(!parent||typeof parent!=='object'||!own(parent,path[i]))return {ok:false,reason:'Elemento inexistente'};
  parent=parent[path[i]];
 }
 if(!parent||typeof parent!=='object')return {ok:false,reason:'Elemento inexistente'};
 const last=path[path.length-1],current=own(parent,last)?parent[last]:null;
 if(!eq(current,patch.before))return {ok:false,reason:'Otro jugador modificó este objeto primero',value:current};
 if(JSON.stringify(patch.after).length>180000)return {ok:false,reason:'Acción demasiado grande'};
 if(patch.after===null&&Array.isArray(parent)&&Number.isInteger(last))parent.splice(last,1);
 else parent[last]=patch.after;
 return {ok:true};
}
const send=(ws,m)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(m))};
const all=(room,msg)=>{for(const p of room.players.values())send(p.ws,msg)};
const publicPlayers=room=>[...room.players.values()].map(p=>({id:p.id,name:p.name,x:p.x,y:p.y,in:p.in,home:p.home,seat:p.seat,car:p.car,facing:p.facing,stride:p.stride,coopItem:p.coopItem??null,weaponAngle:p.weaponAngle??0}));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.webmanifest':'application/manifest+json','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
const httpServer=http.createServer((req,res)=>{
 let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname)}catch{res.writeHead(400);return res.end()}
 if(pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,rooms:rooms.size}))}
 if(pathname==='/'||pathname.endsWith('/'))pathname+='index.html';
 const f=path.resolve(ROOT,'.'+pathname);
 if(!f.startsWith(ROOT+path.sep)||/(?:^|\/)(?:node_modules|\.git)(?:\/|$)/.test(f)||['server.js','package.json','package-lock.json'].includes(path.basename(f))){res.writeHead(403);return res.end()}
 fs.stat(f,(err,stat)=>{if(err||!stat.isFile()){res.writeHead(404);return res.end('No encontrado')}
 res.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});fs.createReadStream(f).pipe(res)});
});
const wss=new WebSocketServer({server:httpServer,path:'/coop',maxPayload:2*1024*1024});
function newCode(){let c;do{c=crypto.randomBytes(3).toString('hex').toUpperCase()}while(rooms.has(c));return c}
function close(room,why='El anfitrión cerró la partida'){
 all(room,{type:'closed',reason:why});rooms.delete(room.code);
 for(const p of room.players.values()){sessions.delete(p.ws);try{p.ws.close()}catch{}}
}
function notify(room){all(room,{type:'players',hostId:room.host,players:publicPlayers(room)})}
function disconnect(ws){const p=sessions.get(ws);if(!p)return;sessions.delete(ws);const room=rooms.get(p.room);if(!room)return;
 if(room.host===p.id)return close(room,'El anfitrión se desconectó; la sala se cerró');
 room.players.delete(p.id);delete room.seats[p.id];all(room,{type:'seats',seats:room.seats});notify(room)
}
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
function join(ws,room,name){const id=crypto.randomUUID();const p={id,ws,room:room.code,name:String(name||'Jugador').slice(0,20).replace(/[<>]/g,''),x:0,y:0,in:false,home:0,seat:null,car:null,facing:'S',stride:0,coopItem:null,weaponAngle:0};
 room.players.set(id,p);sessions.set(ws,p);
 send(ws,{type:'joined',id,host:room.host===id||!room.host,hostId:room.host||id,code:room.code,players:publicPlayers(room),world:room.world,seats:room.seats,revision:room.revision});notify(room);return p
}
// Botín con arbitraje único del servidor: primera solicitud válida gana.
// Las pertenencias (inventario) no forman parte del estado compartido.
function lootTarget(world,source){
 if(!world||!source||typeof source!=='object')return null;
 const i=source.index,h=source.home;
 if(!Number.isInteger(i)||i<0||i>500)return null;
 if(source.type==='home'){
  if(!Number.isInteger(h)||h<0||h>500)return null;
  return world.homes?.[h]?.loot?.[i]??null;
 }
 if(source.type==='police'||source.type==='armory')return world.police?.loot?.[i]??null;
 if(source.type==='shop')return world.shopLoot?.[i]??null;
 if(source.type==='bin')return world.parkingBins?.[i]??null;
 return null;
}
function takeLoot(room,p,m){
 const source=m.source,contents=lootTarget(room.world,source),index=m.index;
 if(!Array.isArray(contents)||!Number.isInteger(index)||index<0||index>=contents.length){
  send(p.ws,{type:'loot-result',requestId:m.requestId,source,ok:false,reason:'Ya no está disponible'});return;
 }
 const armory=source.type==='armory';
 const entry=armory?{id:contents[index],slot:index}:contents[index];
 if(entry==null||entry.id==null&&armory||!eq(entry,m.expected)){
  send(p.ws,{type:'loot-result',requestId:m.requestId,source,ok:false,reason:'Ya no está disponible'});
  all(room,{type:'loot-updated',source,contents,revision:room.revision});return;
 }
 const id=typeof entry==='number'?entry:entry.id;
 if(!Number.isInteger(id)||id<0||id>100)return;
 if(armory)contents[index]=null;else contents.splice(index,1);
 if(source.type==='home'&&!contents.length){
  const h=room.world.homes[source.home];if(h?.searched)h.searched[source.index]=true;
 }
 room.revision++;
 all(room,{type:'loot-updated',source,contents,revision:room.revision});
 send(p.ws,{type:'loot-result',requestId:m.requestId,source,ok:true,entry,revision:room.revision});
}
function takeAllLoot(room,p,m){
 const source=m.source,contents=lootTarget(room.world,source);
 if(!Array.isArray(contents)||!contents.length){send(p.ws,{type:'loot-result',requestId:m.requestId,source,ok:false,reason:'Ya no está disponible'});return}
 const armory=source.type==='armory';
 const entries=armory?contents.map((id,slot)=>id==null?null:{id,slot}).filter(Boolean):contents.slice();
 if(!entries.length){send(p.ws,{type:'loot-result',requestId:m.requestId,source,ok:false,reason:'Ya no está disponible'});return}
 if(armory)contents.fill(null);else contents.splice(0,contents.length);
 if(source.type==='home'){const h=room.world.homes[source.home];if(h?.searched)h.searched[source.index]=true}
 room.revision++;
 all(room,{type:'loot-updated',source,contents,revision:room.revision});
 send(p.ws,{type:'loot-result',requestId:m.requestId,source,ok:true,entries,revision:room.revision});
}
function seatOccupied(room,car){return Object.values(room.seats).filter(x=>x.car===car).map(x=>x.seat)}
function seatChange(room,p,m){
 if(m.car===null){delete room.seats[p.id];p.seat=null;p.car=null;all(room,{type:'seats',seats:room.seats});notify(room);return}
 const car=String(m.car||'').slice(0,80);if(!car)return;
 const carObj=room.world?.cars?.find(c=>String(c.id)===car);
 if(!carObj||!!carObj.in!==!!p.in||(carObj.in&&carObj.home!==p.home)||Math.hypot((carObj.x||0)-p.x,(carObj.y||0)-p.y)>260){send(p.ws,{type:'notice',message:'Acercate al vehículo para subir'});return}
 // El primer conductor puede desbloquearlo con su propia llave; el servidor
 // actualiza el vehículo de TODOS, incluso si quien lo abrió es invitado.
 const existingDriver=Object.values(room.seats).some(entry=>entry.car===car&&entry.seat==='driver');
 if(!existingDriver&&!carObj.unlocked){
  if(!m.hasKey){send(p.ws,{type:'notice',message:'Necesitás la llave de este vehículo'});return}
  carObj.unlocked=true;room.revision++;
  all(room,{type:'vehicle-unlocked',car,revision:room.revision});
 }
 const taken=seatOccupied(room,car);const options=['driver','passenger1','passenger2','passenger3'];const seat=options.find(x=>!taken.includes(x));
 if(!seat){send(p.ws,{type:'notice',message:'Todos los asientos están ocupados'});return}
 room.seats[p.id]={car,seat};p.seat=seat;p.car=car;all(room,{type:'seats',seats:room.seats});all(room,{type:'vehicle',car,state:{x:carObj.x,y:carObj.y,angle:carObj.angle,in:!!carObj.in,home:carObj.home??null,speed:carObj.speed||0,fuel:carObj.fuel,condition:carObj.condition,motor:!!carObj.motor,unlocked:!!carObj.unlocked,siren:!!carObj.siren}});notify(room)
}

// Una mochila es un objeto mundial único. Node procesa solicitudes de forma secuencial.
function dropBackpack(room,p,m){
 if(!room.world||!m.inventory||typeof m.inventory!=='object')return;
 const inventory=m.inventory;
 const items={};
 for(const [key,value] of Object.entries(inventory.items||{})){
  const id=Number(key),qty=Number(value);
  if(Number.isInteger(id)&&id>=0&&id<48&&Number.isInteger(qty)&&qty>0)items[id]=Math.min(9999,qty);
 }
 const keys=x=>Array.isArray(x)?x.filter(v=>typeof v==='string'||Number.isInteger(v)).slice(0,200):[];
 const mag={};for(const id of [4,5,6])mag[id]=Math.max(0,Math.min(100,Math.floor(Number(inventory.magazines?.[id])||0)));
 const bag={kind:'backpack',bagId:crypto.randomUUID(),owner:p.name,inventory:{items,magazines:mag,carKeys:keys(inventory.carKeys),gateKeys:keys(inventory.gateKeys),toolWear:Object.fromEntries(Object.entries(inventory.toolWear||{}).filter(([k,v])=>Number.isInteger(Number(k))&&Number(k)>=0&&Number(k)<48&&Number.isFinite(Number(v))).map(([k,v])=>[k,Math.max(0,Math.min(100,Number(v)))]))},x:p.x,y:p.y,in:p.in,home:p.home};
 room.world.deathBags??=[];
 room.world.deathBags.push(bag);
 room.revision++;
 all(room,{type:'bag-added',bag,revision:room.revision});
}
function claimBackpack(room,p,m){
 const arr=room.world?.deathBags;if(!Array.isArray(arr))return;
 const i=arr.findIndex(d=>d.kind==='backpack'&&d.bagId===m.bagId);
 if(i<0)return;
 const bag=arr[i];
 if(!!bag.in!==p.in||(bag.in&&bag.home!==p.home)||Math.hypot(bag.x-p.x,bag.y-p.y)>115)return;
 arr.splice(i,1);
 room.revision++;
 all(room,{type:'bag-claimed',bagId:bag.bagId,bag,claimant:p.id,revision:room.revision});
}
wss.on('connection',ws=>{
 ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true});
 ws.on('message',raw=>{let m;try{m=JSON.parse(String(raw))}catch{return}
 let p=sessions.get(ws);
 if(!p){
  if(m.type==='create'){const room={code:newCode(),host:null,world:null,players:new Map(),seats:{},lastWorld:0,revision:0};rooms.set(room.code,room);p=join(ws,room,m.name);room.host=p.id;send(ws,{type:'host'});return}
  if(m.type==='join'){const room=rooms.get(String(m.code||'').trim().toUpperCase());if(!room)return send(ws,{type:'error',message:'No se encontró la sala'});if(room.players.size>=MAX)return send(ws,{type:'error',message:'La sala está completa'});if(!room.world)return send(ws,{type:'error',message:'La partida todavía no está lista'});join(ws,room,m.name);return}
  return;
 }
 const room=rooms.get(p.room);if(!room)return;
 if(m.type==='world'&&room.host===p.id){
  if(Date.now()-room.lastWorld<350)return;
  if(!m.world||typeof m.world!=='object')return;
  // No aceptar una imagen anterior a la última transacción aprobada.
  if(Number(m.revision||0)<room.revision){send(p.ws,{type:'resync',revision:room.revision,world:room.world});return}
  room.lastWorld=Date.now();if(room.world?.cars&&m.world?.cars){for(const previous of room.world.cars){const fresh=m.world.cars.find(c=>String(c.id)===String(previous.id));if(fresh){fresh.unlocked=!!(fresh.unlocked||previous.unlocked);if(Object.values(room.seats).some(v=>v.car===String(previous.id)&&v.seat==='driver')){Object.assign(fresh,{x:previous.x,y:previous.y,angle:previous.angle,speed:previous.speed,fuel:previous.fuel,condition:previous.condition,motor:!!previous.motor,siren:!!previous.siren});}}}}room.world=m.world;
  for(const q of room.players.values())if(q.id!==p.id)send(q.ws,{type:'world',world:m.world});
 }else if(m.type==='pose'){
  const x=Number(m.x),y=Number(m.y);if(!Number.isFinite(x)||!Number.isFinite(y))return;
  p.x=clamp(x,-100000,100000);p.y=clamp(y,-100000,100000);p.in=!!m.in;p.home=clamp(Number(m.home)||0,0,300);p.facing=['N','S','E','W'].includes(m.facing)?m.facing:'S';p.stride=Number(m.stride)||0;p.coopItem=Number.isInteger(m.coopItem)&&m.coopItem>=0&&m.coopItem<100?m.coopItem:null;p.weaponAngle=Number.isFinite(Number(m.weaponAngle))?Number(m.weaponAngle):0;
  for(const q of room.players.values())if(q.id!==p.id)send(q.ws,{type:'pose',player:{id:p.id,name:p.name,x:p.x,y:p.y,in:p.in,home:p.home,facing:p.facing,stride:p.stride,seat:p.seat,car:p.car,coopItem:p.coopItem,weaponAngle:p.weaponAngle}})
 }else if(m.type==='transaction'&&room.host!==p.id){
  if(!room.world||!Array.isArray(m.patches)||m.patches.length<1||m.patches.length>90||String(JSON.stringify(m)).length>380000)return;
  const result=[];const approved=[];
  // Procesamiento sin await: no pueden entremezclarse dos transacciones.
  for(const patch of m.patches){const r=commitPatch(room,patch);result.push({path:patch.path,ok:r.ok,reason:r.reason,value:r.value});if(r.ok)approved.push({path:patch.path,after:patch.after})}
  if(approved.length){room.revision++;all(room,{type:'transaction-applied',from:p.id,revision:room.revision,patches:approved});}
  send(p.ws,{type:'transaction-result',id:String(m.id).slice(0,60),revision:room.revision,result});
 }else if(m.type==='loot-take'){
  takeLoot(room,p,m);
 }else if(m.type==='loot-take-all'){
  takeAllLoot(room,p,m);
 }else if(m.type==='zombie-hit'&&room.host!==p.id){
  const host=room.players.get(room.host);if(!Number.isFinite(Number(m.damage)))return;
  send(host?.ws,{type:'zombie-hit',index:m.index,x:m.x,y:m.y,damage:m.damage,angle:m.angle,split:m.split,in:!!m.in,home:m.home,from:p.id});
 }else if(m.type==='player-damage'&&room.host===p.id){const target=room.players.get(String(m.target));if(target&&target.id!==p.id&&Number.isFinite(Number(m.damage))){send(target.ws,{type:'player-damage',damage:clamp(Number(m.damage),0,20)})}}
 else if(m.type==='bag-drop'){dropBackpack(room,p,m)}
 else if(m.type==='bag-claim'){claimBackpack(room,p,m)}
 else if(m.type==='seat')seatChange(room,p,m);
 else if(m.type==='vehicle'){
  if(room.seats[p.id]?.seat!=='driver'||room.seats[p.id]?.car!==m.car)return;
  const car=m.state;if(!car||!Number.isFinite(car.x)||!Number.isFinite(car.y)||!Number.isFinite(car.angle))return;
  const existing=room.world?.cars?.find(c=>String(c.id)===String(m.car));
  if(existing)Object.assign(existing,{x:car.x,y:car.y,angle:car.angle,in:!!car.in,home:car.home??null,speed:Number(car.speed)||0,fuel:car.fuel,condition:car.condition,motor:!!car.motor,unlocked:!!(existing.unlocked||car.unlocked),siren:!!car.siren});
  for(const q of room.players.values())if(q.id!==p.id)send(q.ws,{type:'vehicle',car:m.car,state:{x:car.x,y:car.y,angle:car.angle,in:!!car.in,home:car.home??null,speed:Number(car.speed)||0,fuel:car.fuel,condition:car.condition,motor:!!car.motor,unlocked:!!(existing?.unlocked||car.unlocked),siren:!!car.siren}})
 }else if(m.type==='leave'){disconnect(ws);try{ws.close()}catch(e){}}
 else if(m.type==='close'&&p.id===room.host)close(room);
 });
 ws.on('close',()=>disconnect(ws));ws.on('error',()=>disconnect(ws));
});
setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue}ws.isAlive=false;ws.ping()}},30000).unref();
httpServer.listen(PORT,'0.0.0.0',()=>console.log('Zombie-nvenidos COOP v0.68 on port',PORT));
