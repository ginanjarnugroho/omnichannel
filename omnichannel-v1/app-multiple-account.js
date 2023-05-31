const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const fileUpload = require('express-fileupload');
const axios = require('axios');
const cors = require('cors');

const { db, admin } = require("./helpers/firestore-db");
const chat = require("./models/chat");

// import the book module
const message = require('./message');

const port = process.env.PORT || 8184;

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
  cors: { origin: ['https://inovasy-api-crm-app.azurewebsites.net', 'http://localhost:4200'], credentials: true },
  transports: ['websocket'],
  perMessageDeflate: false
});

/**
 * BASED ON MANY QUESTIONS
 * Actually ready mentioned on the tutorials
 * 
 * The two middlewares above only handle for data json & urlencode (x-www-form-urlencoded)
 * So, we need to add extra middleware to handle form-data
 * Here we can use express-fileupload
 */
app.use(fileUpload({
  debug: false
}));

app.get('/', (req, res) => {
  res.sendFile('index-multiple-account.html', {
    root: __dirname
  });
});

app.get('/state', async (req, res) => {
  // fetch the data from the database, for example from MongoDB
  try {
    // then send the data with a HTTP code
    res.status(200).send("Success!")
  } catch (error) {
    // or send the error
    res.status(404).send(error)
  }
});

const sessions = [];
const SESSIONS_FILE = './whatsapp-sessions.json';

const createSessionsFileIfNotExists = function () {
  if (!fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
      console.log('Sessions file created successfully.');
    } catch (err) {
      console.log('Failed to create sessions file: ', err);
    }
  }
}

createSessionsFileIfNotExists();

const setSessionsFile = function (sessions) {
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function (err) {
    if (err) {
      console.log(err);
    }
  });
}

const getSessionsFile = function () {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE));
}

const createSession = function (id, description) {
  console.log('Session : ' + id );
  try {
    const client = new Client({
      restartOnAuthFail: false,
      puppeteer: {
        headless: true,
        devtools: false, // not needed so far, we can see websocket frames and xhr responses without that.
        // Coment jika sedang jalan di local, jangan lupa di uncoment jika akan di push
        executablePath: '/usr/bin/google-chrome',
        args: [
          /* TODO : https://peter.sh/experiments/chromium-command-line-switches/
        there is still a whole bunch of stuff to disable
      */
          //'--crash-test', // Causes the browser process to crash on startup, useful to see if we catch that correctly
          // not idea if those 2 aa options are usefull with disable gl thingy
          '--disable-canvas-aa', // Disable antialiasing on 2d canvas
          '--disable-2d-canvas-clip-aa', // Disable antialiasing on 2d canvas clips
          '--disable-gl-drawing-for-tests', // BEST OPTION EVER! Disables GL drawing operations which produce pixel output. With this the GL output will not be correct but tests will run faster.
          '--disable-dev-shm-usage', // ???
          '--no-zygote', // wtf does that mean ?
          '--use-gl=swiftshader', // better cpu usage with --use-gl=desktop rather than --use-gl=swiftshader, still needs more testing.
          '--enable-webgl',
          '--hide-scrollbars',
          '--mute-audio',
          '--no-first-run',
          '--disable-infobars',
          '--disable-breakpad',
          //'--ignore-gpu-blacklist',
          '--window-size=1280,1024', // see defaultViewport
          '--user-data-dir=./chromeData', // created in index.js, guess cache folder ends up inside too.
          '--no-sandbox', // meh but better resource comsuption
          '--disable-setuid-sandbox'// same
          // '--proxy-server=socks5://127.0.0.1:9050'] // tor if needed
        ],
      },
      authStrategy: new LocalAuth({
        clientId: id
      })
    });

    client.initialize();

    client.on('qr', (qr) => {
      console.log('QR RECEIVED', qr);
      qrcode.toDataURL(qr, (err, url) => {
        io.emit('qr', { id: id, src: url });
        io.emit('message', { id: id, text: 'QR Code received, scan please!' });
      });

      const used = process.memoryUsage();
      for (let key in used) {
        console.log(`Memory: ${key} ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
      }

    });

    client.on('ready', () => {
      io.emit('ready', { id: id });
      io.emit('message', { id: id, text: 'Whatsapp is ready!' });

      const savedSessions = getSessionsFile();
      const sessionIndex = savedSessions.findIndex(sess => sess.id == id);

      if (sessionIndex > -1) {
        savedSessions[sessionIndex].ready = true;
        setSessionsFile(savedSessions);
      }

    });

    client.on('authenticated', () => {
      io.emit('authenticated', { id: id });
      io.emit('message', { id: id, text: 'Whatsapp is authenticated!' });
    });

    client.on('auth_failure', function () {
      io.emit('message', { id: id, text: 'Auth failure, restarting...' });
    });

    client.on('disconnected', (reason) => {
      io.emit('message', { id: id, text: 'Whatsapp is disconnected!' });
      client.destroy();
      client.initialize();

      // Menghapus pada file sessions
      const savedSessions = getSessionsFile();
      const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
      savedSessions.splice(sessionIndex, 1);
      setSessionsFile(savedSessions);

      io.emit('remove-session', id);
    });

    //triger ketika pesan di buat baik terima pesan atau kirim
    client.on('message_create', async msg => {
      if (msg.from == 'status@broadcast')
        return;

      if (msg.type != "chat")
        return;

      if ((await msg.getChat()).isGroup == false) {
        if (msg.fromMe == true) {

          const name = (await client.getContactById(msg.to)).pushname;

          await addOrUpdateChat(msg.to, msg.to, msg.from, msg.fromMe, 0, msg.body, msg.timestamp, name);
        }
        else {
          const name = (await client.getContactById(msg.from)).pushname;

          await addOrUpdateChat(msg.from, msg.from, msg.to, msg.fromMe, 0, msg.body, msg.timestamp, name);

          io.emit('message', msg);
        }
      }
    });

    // Tambahkan client ke sessions
    sessions.push({
      id: id,
      description: description,
      client: client
    });

    // Menambahkan session ke file
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);

    if (sessionIndex == -1) {
      savedSessions.push({
        id: id,
        description: description,
        ready: false,
      });
      setSessionsFile(savedSessions);
    }
  } catch (error) {
    console.log("Retry!", error);
  }
}

const init = function (socket) {
  const savedSessions = getSessionsFile();

  if (savedSessions.length > 0) {
    if (socket) {
      /**
       * At the first time of running (e.g. restarting the server), our client is not ready yet!
       * It will need several time to authenticating.
       * 
       * So to make people not confused for the 'ready' status
       * We need to make it as FALSE for this condition
       */
      savedSessions.forEach((e, i, arr) => {
        arr[i].ready = false;
      });

      socket.emit('init', savedSessions);
    } else {
      savedSessions.forEach(sess => {
        createSession(sess.id, sess.description);
      });
    }
  }
}

init();

// Socket IO
io.on('connection', function (socket) {
  init(socket);

  socket.on('create-session', function (data) {
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == data.id);
    if (sessionIndex > -1) {

      console.log("sessionIndex", sessionIndex);
      if (savedSessions[sessionIndex].ready == false) {
      console.log("savedSessions[sessionIndex].ready", savedSessions[sessionIndex].ready);

        createSession(data.id, data.description);
      }
    }
    else {
      createSession(data.id, data.description);
    }
  });

  socket.on('disconnect', function (data) {
    destroy();
  });

  // var alive = Date.now();
  // socket.on('am_alive', (data) => {
  //   alive = Date.now();
  // }); // client tell the server that it is alive

  // const intv = setInterval(() => {
  //   if (Date.now() > alive + 20000) {
  //     //sever checks if clients has no activity in last 20s
  //     destroy();
  //     clearInterval(intv);
  //   }
  // }, 10000);

  function destroy() {
    try {
      socket.disconnect();
      socket.removeAllListeners();
      socket = null; //this will kill all event listeners working with socket
      //set some other stuffs to NULL
    } catch { }
  }
});

// Send message
app.post('/send-message/:clientId', async (req, res) => {

  const clientId = req.params.clientId;
  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;

  console.log("clientId", clientId);

  console.log("number", number);


  const client = sessions.find(sess => sess.id == clientId)?.client;

  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(500).json({
      status: false,
      message: `The sender: ${clientId} is not found!`
    })
  }

  try {
    client.sendMessage(number, message).then(async response => {

      const data = {
        Body: response.body,
        From: response.from,
        FromMe: response.fromMe,
        IsRead: 0,
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
        response: err.stack
      });
    });
  } catch (error) {
    console.log("error", error);
    res.status(500).json({
      status: false,
      response: error.stack
    });
  }

});

//Get List All Chats By NumberPhone
app.get('/get-chats/:clientId', async (req, res) => {

  const clientId = req.params.clientId;

  var usersArray = [];

  try {
    const number = phoneNumberFormatter(clientId);

    const client = sessions.find(sess => sess.id == clientId)?.client;

    // Make sure the sender is exists & ready
    if (!client) {
      return res.status(200).json({
        status: false,
        message: `The sender: ${clientId} is not found!`
      })
    }

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
          response: error.stack
        });
      });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.stack
    });
  }

  var sorted = usersArray.sort(function (a, b) {
    return a.TimeStamp < b.TimeStamp ? 1 : -1;
  });

  res.status(200).json({
    status: true,
    response: sorted
  });

});

//phone number must be format 62{your number} or 0{phone number}
app.get('/get-chatbyId/:clientId/:id', async (req, res) => {

  const clientId = req.params.clientId;

  console.log("clientId", clientId);

  const number = phoneNumberFormatter(req.params.id);

  const client = sessions.find(sess => sess.id == clientId)?.client;


  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(500).json({
      status: false,
      message: `The sender: ${clientId} is not found!`
    })
  }

  var usersArray = [];

  if (number == undefined) {
    res.status(200).json({
      status: true,
      response: `The sender: ${number} is not found!`
    });
  }


  try {
    //get list chat by phone number
    let chatdoc = await db.collection("chat").doc(number).get();

    if (chatdoc.exists) {
      chatdoc.ref.update({
        UnreadCount: 0
      });
    }

    await db.collection("chat")
      .doc(number)
      .collection("message")
      .orderBy('TimeStamp')
      .get()
      .then(querySnapshot => {
        querySnapshot.forEach((doc) => {
          usersArray.push(doc.data());
        });
      }).catch(error => {
        res.status(500).json({
          status: false,
          response: error.stack
        });
      });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.stack
    });
  }

  res.status(200).json({
    status: true,
    response: usersArray
  });
});

//get list contacts must be format 62 {your number}
app.get('/get-contacts/:id', async (req, res) => {

  const clientId = req.params.id;

  const number = phoneNumberFormatter(req.params.id);

  const client = sessions.find(sess => sess.id == clientId)?.client;

  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(500).json({
      status: false,
      message: `The sender: ${clientId} is not found!`
    })
  }

  try {
    //get list contacts
    var result = await client.getContacts();
    res.status(200).json({
      status: true,
      response: result
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.stack
    });
  }

});

async function addOrUpdateChat(noDoc, noSender, noReceiver, fromMe, tenantId, body, timestamp, name) {
  try {
    noDoc = phoneNumberFormatter(noDoc);
    const from = phoneNumberFormatter(noSender);
    const to = phoneNumberFormatter(noReceiver);

    await db.collection("chat")
      .doc(noDoc)
      .get()
      .then(async (doc) => {

        if (doc.data() == undefined) {
          db.collection("chat").doc(noDoc).set({
            From: from,
            Name: name,
            To: to,
            FromMe: fromMe,
            TenantId: 0,
            LastMessage: body,
            TimeStamp: timestamp,
            UnreadCount: (fromMe == true) ? 0 : 1,
          }).then(result => {
            console.log("suksess di tambah");
          }).catch(error => {
            console.log("errro disini" + error);
          });
        }
        else {
          //update last message and counter message unread
          var readCount = doc.data().UnreadCount;

          // console.log("doc.data().UnreadCount", readCount);
          // console.log("doc.data().tambah", readCount+1);

          db.collection("chat").doc(noDoc).update({
            LastMessage: body,
            TimeStamp: timestamp,
            Name: name,
            UnreadCount: doc.data().UnreadCount + ((fromMe == true) ? 0 : 1)
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
      .then(function (response) {
        console.log("Successfully sent message! Server response:", response);
      })
      .catch(function (error) {
        console.log("Error sending message:", error);
      });

  } catch (error) {
    console.log(error);
  }
}

server.listen(port, function () {
  console.log('App running on *: ' + port);
});
