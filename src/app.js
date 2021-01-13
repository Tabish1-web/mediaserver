const express = require('express')
const app = express()
const https = require('httpolyglot')
const fs = require('fs')
const mediasoup = require('mediasoup')
const config = require('./config')
const path = require('path')
const Room = require('./Room')
const Peer = require('./Peer')

const options = {
    key: fs.readFileSync(path.join(__dirname,config.sslKey), 'utf-8'),
    cert: fs.readFileSync(path.join(__dirname,config.sslCrt), 'utf-8')
}

const httpsServer = https.createServer(options, app)
const io = require('socket.io')(httpsServer)

httpsServer.listen(config.listenPort, () => {
    console.log('listening https ' + config.listenPort)
})
let workers = []
let nextMediasoupWorkerIdx = 0
let roomList = new Map();

(async () => {
    await createWorkers()
})()

async function createWorkers() {
    let {
        numWorkers
    } = config.mediasoup
    for (let i = 0; i < numWorkers; i++) {
        let worker = await mediasoup.createWorker({
            logLevel: config.mediasoup.worker.logLevel,
            logTags: config.mediasoup.worker.logTags,
            rtcMinPort: config.mediasoup.worker.rtcMinPort,
            rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
        })
        worker.on('died', () => {
            console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
            setTimeout(() => process.exit(1), 2000);
        })
        workers.push(worker)
    }}
// send current time
    async function Time(io){
        setInterval(()=>{
        let current_time = new Date()
        let yrs = current_time.getFullYear()
        let mon = current_time.getMonth()
        let dat = current_time.getDate()
        let hrs = current_time.getHours()
        let min = current_time.getMinutes()
        let sec = current_time.getSeconds()
        if(hrs < 10){
            hrs = `0${hrs}`
        }
        if(min < 10){
            min = `0${min}`
        }
        if(sec < 10){
            sec = `0${sec}`
        }
        if(mon+1 < 10){
            mon = `0${mon+1}`
        }
        if(dat < 10){
            dat = `0${dat}`
        }
        io.emit('currenttime',`${yrs}-${mon}-${dat}T${hrs}:${min}:${sec}`)
    },500);
    }
// send network settings
function sendNetwork(socket,my_room,my_peer){
    let my_tutor = null
    my_room.send(socket.id,'mystatus',{name:my_peer.name,network:my_peer.network});
    for(let otherID of Array.from(my_room.peers.values()).filter(peer => peer.account == 'tutor')){
        my_tutor = otherID
    }
    if(my_peer == my_tutor){
        my_room.broadCast(socket.id,'status',{name:my_tutor.name,network:my_tutor.network});
        for(let otherID of Array.from(my_room.peers.values()).filter(peer => peer.account == 'student')){
            my_room.send(socket.id,'status',{name:otherID.name,network:otherID.network});
        }
    }else{
        if(my_tutor !== null){
            my_room.send(socket.id,'status',{name:my_tutor.name,network:my_tutor.network})
            my_room.send(my_tutor.id,'status',{name:my_peer.name,network:my_peer.network})
        }
    }
}
// io connections
io.on('connection', socket => {
    Time(io);
    socket.on('createRoom', async ({
        room_id
    }, callback) => {
        if (roomList.has(room_id)) {
            callback('already exists')
        } else {
            let worker = await getMediasoupWorker()
            roomList.set(room_id, new Room(room_id, worker, io))
            callback(room_id)
        }
    })
    socket.on('join',async ({
        room_id,
        name,
        account
    }, cb) => {
        if (!roomList.has(room_id)) {
            return cb({
                error: 'room does not exist'
            })
        }
        await roomList.get(room_id).addPeer(new Peer(socket.id, name, account))
        socket.room_id = room_id
        cb(roomList.get(room_id).toJson())
    })
    socket.on('networkinfo',async ({room_id,net_rtt,type})=>{
        let my_room = await roomList.get(room_id)
        let my_peer = await my_room.getPeers().get(socket.id)
        my_peer.network = {net:net_rtt,type:type}
        sendNetwork(socket,my_room,my_peer)
    })
    socket.on('sendmessage',async data=>{
        let my_room = await roomList.get(socket.room_id);
        my_room.send(socket.id,'receivemessage',data);
        my_room.broadCast(socket.id,'receivemessage',data);
    });
    socket.on('sendtypemessage',async data=>{
        let my_room = await roomList.get(socket.room_id)
        my_room.broadCast(socket.id,'receivetypemessage',data)
    });
    socket.on('raisehand',async ({email,raise})=>{
        let my_room = await roomList.get(socket.room_id)
        let tutor = null;
        let student = null;
        for (let otherID of Array.from(my_room.peers.values()).filter(peer => peer.account == 'tutor')){
            tutor = otherID;
        }
        for (let otherID of Array.from(my_room.peers.values()).filter(peer => peer.name == email)){
            student = otherID;
        }
        my_room.send(student.id,'handup',{email:email,raise:raise});
        my_room.send(tutor.id,'handup',{email:email,raise:raise});
    });
    socket.on('setallowed',async ({allow})=>{
        let my_room = await roomList.get(socket.room_id);
        if(my_room.allowed){
        let peer = null;
        for (let otherID of Array.from(my_room.peers.values()).filter(peer => peer.name == my_room.allowed)){
            peer = otherID;
        }
        if(peer){
        for(let pro of peer.producers.keys()){
            peer.closeProducer(pro)
        }
        my_room.send(peer.id,'closeallproducers')
    }}
        my_room.allowed = allow; 
    })
    socket.on('getProducers', async () => {
        if (!roomList.has(socket.room_id)) return
        let my_room = await roomList.get(socket.room_id)
        let my_peer = await my_room.getPeers().get(socket.id)
        if(my_peer.account == 'tutor'){
            let producerList = my_room.getProducerListForTutor(socket.id)
            socket.emit('newProducers', producerList)
        }else{
            let producerList = my_room.getProducerListForStudent(socket.id)
            socket.emit('newProducers', producerList)
        }
    })
    socket.on('getRouterRtpCapabilities', (_, callback) => {
        try {
            callback(roomList.get(socket.room_id).getRtpCapabilities());
        } catch (e) {
            callback({
                error: e.message
            })
        }
    });
    socket.on('createWebRtcTransport', async (_, callback) => {
        try {
            const {
                params
            } = await roomList.get(socket.room_id).createWebRtcTransport(socket.id);
            callback(params);
        } catch (err) {
            console.error(err);
            callback({
                error: err.message
            });
        }
    });
    socket.on('connectTransport', async ({
        transport_id,
        dtlsParameters
    }, callback) => {
        if (!roomList.has(socket.room_id)) return
        await roomList.get(socket.room_id).connectPeerTransport(socket.id, transport_id, dtlsParameters) 
        callback('success')
    })
    socket.on('produce', async ({
        kind,
        rtpParameters,
        producerTransportId
    }, callback) => {  
        if(!roomList.has(socket.room_id)) {
            return callback({error: 'not is a room'})
        }
        let producer_id = await roomList.get(socket.room_id).produce(socket.id, producerTransportId, rtpParameters, kind)
        callback({
            producer_id
        })
    })
    socket.on('consume', async ({
        consumerTransportId,
        producerId,
        rtpCapabilities
    }, callback) => {
        let params = await roomList.get(socket.room_id).consume(socket.id, consumerTransportId, producerId, rtpCapabilities)
        callback(params)
    });
    socket.on('resume', async (data, callback) => {
        await consumer.resume();
        callback();
    });
    socket.on('getMyRoomInfo', (_, cb) => {
        cb(roomList.get(socket.room_id).toJson())
    });
    socket.on('disconnect',async () => {
        if (!socket.room_id) return
        let tutor = null;
        let student = null;
        let my_room = await roomList.get(socket.room_id)
        let my_peer = await my_room.getPeers().get(socket.id)
        let email = my_peer.name;
        my_peer.network = {net:0,type:'offline'}
        sendNetwork(socket,my_room,my_peer)
        for (let otherID of Array.from(my_room.peers.values()).filter(peer => peer.account == 'tutor')){
            tutor = otherID;
        }
        for (let otherID of Array.from(my_room.peers.values()).filter(peer => peer.name == email)){
            student = otherID;
        }
        my_room.send(student.id,'handup',{email:email,raise:false});
        my_room.send(tutor.id,'handup',{email:email,raise:false});
        await roomList.get(socket.room_id).removePeer(socket.id)
    })

    socket.on('producerClosed', ({
        producer_id
    }) => {
        roomList.get(socket.room_id).closeProducer(socket.id, producer_id)
    })
    socket.on('exitRoom', async (_, callback) => {
        if (!roomList.has(socket.room_id)) {
            callback({
                error: 'not currently in a room'
            })
            return
        }
        await roomList.get(socket.room_id).removePeer(socket.id)
        if (roomList.get(socket.room_id).getPeers().size === 0) {
            roomList.delete(socket.room_id)
        }
        socket.room_id = null
        callback('successfully exited room')
    })
})
function room() {
    return Object.values(roomList).map(r => {
        return {
            router: r.router.id,
            peers: Object.values(r.peers).map(p => {
                return {
                    name: p.name,
                }
            }),
            id: r.id
        }
    })
}
function getMediasoupWorker() {
    const worker = workers[nextMediasoupWorkerIdx];
    if (++nextMediasoupWorkerIdx === workers.length)
        nextMediasoupWorkerIdx = 0;
    return worker;
}