//const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
var admin = require("firebase-admin");

//set private key
const serviceAccount = require('../inovasy-omnichannel-firebase-adminsdk-prod.json');

// Initialize the app with a service account, granting admin privileges
// initializeApp({
//   credential: admin.credential.cert(serviceAccount)
// });

// Initialize the app with a service account, granting admin privileges
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


const db = getFirestore();

module.exports = { db, admin }
