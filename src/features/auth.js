const { google } = require('googleapis');
const util = require('util');
const fs = require('fs');
const path = require("path");
const dotenv = require('dotenv');
dotenv.config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GoogleGenerativeAI);
const model = genAI.getGenerativeModel({ model: "gemini-pro"});

// variables
let liveChatId; // Where we'll store the id of our liveChat
let nextPage; // How we'll keep track of pagination for chat messages
const intervalTime = 5000; // Miliseconds between requests to check chat messages
let interval; // variable to store and control the interval that will check messages
let chatMessages = []; // where we'll store all messages

const writeFilePromise = util.promisify(fs.writeFile);
const readFilePromise = util.promisify(fs.readFile);


const save = async (path, str) => {
  await writeFilePromise(path, str);
  console.log('Successfully Saved');
};

const read = async path => {
  const fileContents = await readFilePromise(path);
  return JSON.parse(fileContents);
};

const youtube = google.youtube('v3');
const OAuth2 = google.auth.OAuth2;


const clientId =  process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const redirectURI = 'http://localhost:3000/callback';

// Permissions needed to view and submit live chat comments
const scope = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl'
];

const auth = new OAuth2(clientId, clientSecret, redirectURI);

const googleService = {};

googleService.getCode = response => {
  const authUrl = auth.generateAuthUrl({
    access_type: 'offline',
    scope
  });
  response.redirect(authUrl);
};

// Request access from tokens using code from login
googleService.getTokensWithCode = async code => {
  const credentials = await auth.getToken(code);
  googleService.authorize(credentials);
};

// Storing access tokens received from google in auth object
googleService.authorize = ({ tokens }) => {
  auth.setCredentials(tokens);
  console.log('Successfully set credentials');
  console.log('tokens:', tokens);
  save(
    path.join(process.cwd(), "src", "tokens.json"),
    JSON.stringify(tokens)

  );
};

googleService.findActiveChat = async () => {
  const response = await youtube.liveBroadcasts.list({
    auth,
    part: 'snippet',
    mine: 'true'
  });
  const latestChat = response.data.items[0];

  if (latestChat && latestChat.snippet.liveChatId) {
    liveChatId = latestChat.snippet.liveChatId;
    console.log("Chat ID Found:", liveChatId);
  } else {
    console.log("No Active Chat Found");
  }
};

auth.on('tokens', tokens => {
  try {
      if (tokens.refresh_token) {
          // store the refresh_token in my database!
          save('./tokens.json', JSON.stringify(auth.tokens));
          console.log(tokens.refresh_token);
      }
      console.log(tokens.access_token);
  } catch (error) {
      console.log("Error in auth.on in constructor");
      console.log(error.message);
  }
});

// Read tokens from stored file
const checkTokens = async () => {
  try {
    const fileContents = await readFilePromise(
      path.join(process.cwd(), "src", "tokens.json")
    );
    const tokens = JSON.parse(fileContents);
    if (tokens) {
      this.auth.setCredentials(tokens);
      console.log("tokens set");
    } else {
      console.log("No tokens found. Please authorise the app first.");
    }
  } catch (error) {
    console.log("Error in checkToken function");
    console.log(error.message);
  }
}
async function GeminiAI(msg) {
  // For text-only input, use the gemini-pro model
  const model = genAI.getGenerativeModel({ model: "gemini-pro"});
  const prompt = `Is the following message offensive: ${msg} If offensive give answer as true else give as false`
  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = await response.text(); // Await the text() method to get the actual text
  // console.log("AI text ", text);

  // Now, text contains the response text from the model
  let finalResult = null;
  if (text) {
    // Process the text if needed
    finalResult = text;
  }

  // console.log("AI text after filter ", finalResult);
  return finalResult;
}


const respond = newMessages => {
  newMessages.forEach(async message => {
    const messageText = message.snippet.displayMessage.toLowerCase();
    console.log("the is msg "+JSON.stringify(message))
    if (process.env.activeModel === "GeminiAI") {
      const result = await GeminiAI(messageText);
      // console.log("result ", result); // Log the actual result
      // console.log("type of ", typeof result); // Log the type of the result
      
      // Check if the result is "true"
      if (result === "true") {
        const author = message.authorDetails.displayName;
        const response = `${author} This is a final warning. Please be respectful from now on, or you will be permanently banned from the community.`;
        googleService.insertMessage(response);
      }
    }
  });
};


const getChatMessages = async () => {
  const response = await youtube.liveChatMessages.list({
    auth,
    part: 'snippet,authorDetails',
    liveChatId,
    pageToken: nextPage
  });
  const { data } = response;
  const newMessages = data.items;
  chatMessages.push(...newMessages);
  nextPage = data.nextPageToken;
  console.log('Total Chat Messages: ', chatMessages[0].snippet.textMessageDetails.messageText,"message by "+chatMessages[0].authorDetails.displayName);
  respond(newMessages);
};

googleService.startTrackingChat = () => {
  interval = setInterval(getChatMessages, intervalTime);
};

googleService.stopTrackingChat = () => {
  clearInterval(interval);
};

googleService.insertMessage = messageText => {
  youtube.liveChatMessages.insert(
    {
      auth,
      part: 'snippet',
      resource: {
        snippet: {
          type: 'textMessageEvent',
          liveChatId,
          textMessageDetails: {
            messageText
          }
        }
      }
    },
    () => {}
  );
};

checkTokens();

// As we progress throug this turtorial, Keep the following line at the nery bottom of the file
// It will allow other files to access to our functions
module.exports = googleService;