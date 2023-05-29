const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const { body, validationResult } = require('express-validator');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const fileUpload = require('express-fileupload');
const axios = require('axios');
const mime = require('mime-types');

const {db, admin} = require("./helpers/firestore-db");

const chat = require("./models/chat");

// import the book module
const message = require('./message');

const port = process.env.PORT || 6965;

const app = express();
app.use(express.json());

app.use(express.urlencoded({
  extended: true
}));

var corsOptions = {
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept'],
  optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
}

app.use(
  cors({ corsOptions })
);

app.options(
  '*',
  cors({ corsOptions }
  ));

const server = http.createServer(app);
const io = new socketIO.Server(server, {
  allowEIO3: true, // false by default,
  cors: { origin: ['http://localhost:4200', 'https://localhost:7162'], credentials: true }
});

io.sockets.setMaxListeners(0);


/**
 * BASED ON MANY QUESTIONS
 * Actually ready mentioned on the tutorials
 * 
 * Many people confused about the warning for file-upload
 * So, we just disabling the debug for simplicity.
 */
app.use(fileUpload({
  debug: false
}));

app.get('/', (req, res) => {
  res.sendFile('index.html', {
    root: __dirname
  });
});

class MyLocalAuth extends LocalAuth {
  constructor(opts) {
      super(opts)
  }
  async afterBrowserInitialized() {
      super.afterBrowserInitialized()
      this.client.pupBrowser.on('disconnected', () => this.client.emit('pup_disconnected'))
  }
}


const client = new Client({
  restartOnAuthFail: true,
  puppeteer: {
    headless: true,
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--no-first-run',
      '--no-sandbox',
      '--no-zygote',
      '--deterministic-fetch',
      '--disable-features=IsolateOrigins',
      '--disable-site-isolation-trials',
      // '--single-process',
    ],
  },
  authStrategy: new MyLocalAuth()
});

//triger ketika terima pesan private
// client.on('message', async msg => {
//     console.log("message", msg.from);
//     // await addOrUpdateChat(msg.from, msg.from, msg.to, msg.fromMe, 0, msg.body, msg.timestamp);
// });

client.setMaxListeners(900);

client.initialize();

 //triger ketika pesan di buat baik terima pesan atau kirim
 client.on('message_create', async msg => {

  const name = (await msg.getContact()).pushname;

  console.log("test", name);

  if(msg.from == 'status@broadcast')
    return;
  
  if(msg.type != "chat")
    return;

  if((await msg.getChat()).isGroup == false)
    {
      if(msg.fromMe == true)
      {
        await addOrUpdateChat(msg.to, msg.to, msg.from, msg.fromMe, 0, msg.body, msg.timestamp, name);
      }
      else
      {
        await addOrUpdateChat(msg.from, msg.from, msg.to, msg.fromMe, 0, msg.body, msg.timestamp, name);
        io.emit('message', msg);
      }
    }
});

// Socket IO
io.on('connection', function (socket) {

  socket.emit('message', 'Connecting...');

  client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.toDataURL(qr, (err, url) => {
      socket.emit('qr', url);
      console.log("data", url);
      socket.emit('message', 'QR Cod received, scan please!');
    });
  });

  client.on('ready', () => {
    socket.emit('ready', 'Whatsapp is ready!');
    socket.emit('message', 'Whatsapp is ready!');
    console.log("ready bro!");
  });

  client.on('authenticated', () => {
    socket.emit('authenticated', 'Whatsapp is authenticated!');
    socket.emit('message', 'Whatsapp is authenticated!');
    console.log('AUTHENTICATED');
  });

  client.on('auth_failure', function (session) {
    socket.emit('auth_failure', 'Auth failure, restarting...');
    console.log('auth_failure');
  });


  client.on('disconnected', (reason) => {
    socket.emit('disconnected', 'Whatsapp is disconnected!');
    client.destroy();
    client.initialize();
  });

  client.on('pup_disconnected', () => {
    socket.emit('message', 'Whatsapp is disconnected!');
    client.destroy();
    client.initialize();
  }); 
});



const checkRegisteredNumber = async function (number) {
  const isRegistered = await client.isRegisteredUser(number);
  return isRegistered;
}

// Send message
app.post('/send-message', [
  body('number').notEmpty(),
  body('message').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    msg
  }) => {
    return msg;
  });

  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped()
    });
  }

  const number = phoneNumberFormatter(req.body.number);
  // const number = req.body.number;
  const message = req.body.message;

  // const isRegisteredNumber = await checkRegisteredNumber(number);

  // if (!isRegisteredNumber) {
  //   return res.status(422).json({
  //     status: false,
  //     message: 'The number is not registered'
  //   });
  // }

  try {
    client.sendMessage(number, message).then(async response => {

      console.log("berhasil", response);

    const data = {
      Body : response.body,
      From : response.from,
      FromMe : response.fromMe,
      IsRead : 0,
      TimeStamp: response.timestamp,
      To: response.to
    }
      
      res.status(200).json({
        status: true,
        response: data
      });
    }).catch(err => {
      console.log("err", err);
      res.status(500).json({
        status: false,
        response: err
      });
    });
  } catch (error) {
    console.log("error", error);
    res.status(500).json({
      status: false,
      response: err
    });
  }
});

//Get List All Chats By NumberPhone
app.get('/get-chats/:id', async (req, res) => {

  const number = phoneNumberFormatter(req.params.id);

  var usersArray = [];

  //get list chat by phone number
  await db.collection("chat")
    .where('To', '==', number)
    .orderBy('TimeStamp', 'asc')
    .get()
    .then(querySnapshot => {
      querySnapshot.forEach((doc) => {
        // console.log(doc.id, '=>', doc.data());
        usersArray.push(doc.data());
      });
    }).catch(error => {
      res.status(500).json({
        status: false,
        response: error
      });
    });

    res.status(200).json({
      status: true,
      response: usersArray
    });
  
});

//phone number must be format 62{your number} or 0{phone number}
app.get('/get-chatbyId/:id', async (req, res) => {

  const number = phoneNumberFormatter(req.params.id);

  var usersArray = [];

  //get list chat by phone number
  await db.collection("chat")
    .doc(number)
    .collection("message")
    .orderBy('TimeStamp')
    .get()
    .then(querySnapshot => {
      querySnapshot.forEach((doc) => {
        usersArray.push(doc.data());
      });

      console.log("masuk detail");
      db.collection("chat").doc(number).update({
        UnreadCount : 0
      });

    }).catch(error => {
      res.status(500).json({
        status: false,
        response: error
      });
    });

    res.status(200).json({
      status: true,
      response: usersArray
    });
});

//get list contacts must be format 62 {your number}
app.get('/get-contacts/:id', async (req, res) => {

  const number = phoneNumberFormatter(req.params.id);

  try {
    //get list contacts
    var result = await client.getContacts();
    res.status(200).json({
      status: true,
      response: result
    });
  } catch (error) {
    console.log("error", error);
    res.status(500).json({
      status: false,
      response: error.stack
    });
  }
  
});

async function addOrUpdateChat(noDoc, noSender, noReceiver, fromMe, tenantId, body, timestamp, name) {
  try {

    if (name == undefined)
      name = noDoc;

    noDoc = phoneNumberFormatter(noDoc);
    const from = phoneNumberFormatter(noSender);
    const to = phoneNumberFormatter(noReceiver);

    await db.collection("chat")
      .doc(noDoc)
      .get()
      .then(async (doc) => {   
        
        console.log("Read", (fromMe == true) ? 0 : 1);

        if (doc.data() == undefined) {
          db.collection("chat").doc(noDoc).set({
            From: from,
            Name : name,
            To: to,
            FromMe: fromMe,
            TenantId: 0,
            LastMessage: body,
            UnreadCount: doc.data().UnreadCount + (fromMe == true) ? 0 : 1
          }).then(result => {
            console.log("suksess di tambah");
          }).catch(error => {
            console.log("errro disini" + error);
          });
        }
        else {
          //update last message and counter message unread
          if(doc.data().Name != noSender)
            name = doc.data().Name;

          console.log("Read", (fromMe == true) ? 0 : 1);

          db.collection("chat").doc(noDoc).update({
            LastMessage: body,
            TimeStamp: timestamp,
            Name: name,
            UnreadCount: doc.data().UnreadCount + (fromMe == true) ? 0 : 1
          }).then(result => {
            console.log("suksess di update");
          }).catch(error => {
            console.log("errro disini" + error);
          });
        }
        // insert new message
        db.collection('chat').doc(noDoc).collection('message').add({
          From: from,
          To: to,
          FromMe: fromMe,
          Body: body,
          TimeStamp: timestamp,
          IsRead: 0
        }).then(result => {
          console.log("suksess add new message");
        }).catch(error => {
          console.log("errro disini" + error);
        });
      });

      // // Define who to send the message to
      let condition = "'falcons' in topics || 'patriots' in topics";
      
      // // Define the message payload
      let payload = {
        notification: {
          title: "Falcons vs. Patriots",
          body: "Get the inside scoop on the big game."
        }
      };
      
      // // Send a message to the condition with the provided payload
      admin.messaging().sendToCondition(condition, payload)
        .then(function(response) {
          console.log("Successfully sent message! Server response:", response);
        })
        .catch(function(error) {
          console.log("Error sending message:", error);
        }); 
    
  } catch (error) {
    console.log(error);
  }
}

server.listen(port, function () {
  console.log('App running on *: ' + port);
});



