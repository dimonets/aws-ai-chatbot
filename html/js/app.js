//const chatBotServiceUrl = 'http://localhost:3000';  - is set in config.js file automatically by CDK script

const chatOpen = document.getElementById('chat-open');
const chatClose = document.getElementById('chat-close');
const chatWidget = document.getElementById('chat-widget');
const chatContainer = document.getElementById('chat-container');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendButton = document.getElementById('chat-send');

// Getting the user Id and chat Id from HTML (for future logging)
let userId = document.getElementById('chat-u').value;
let chatId = document.getElementById('chat-i').value;
if (chatId === '')
  chatId = Date.now();

let chatVisible = false;
let introMessageSent = false;

// Open chat button click handler
chatOpen.addEventListener('click', () => {
  chatWidget.classList.toggle('visible', true);
  //chatInput.focus();
});

// Close chat button click handler
chatClose.addEventListener('click', () => {
  chatWidget.classList.toggle('visible', false);
});

// Enter key handler to send message
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const userInput = chatInput.value.trim();
    if (userInput) {
      addChatMessage('You', userInput);
      sendChatMessage(userInput);
      chatInput.value = '';
    }
  }
});

// Send message button click handler to send message
chatSendButton.addEventListener('click', () => {
  const userInput = chatInput.value.trim();
  if (userInput) {
    addChatMessage('You', userInput);
    sendChatMessage(userInput);
    chatInput.value = '';
  }
});

// Add chat message to DOM
function addChatMessage(sender, message) {
  const messageContainer = document.createElement('div');
  messageContainer.classList.add('chat-message-container');
  const messageHeader = document.createElement('div');
  messageHeader.classList.add('chat-message-header');
  messageHeader.textContent = sender + ':';
  const messageBody = document.createElement('div');
  messageBody.classList.add('chat-message-body');
  messageBody.textContent = message;
  messageContainer.appendChild(messageHeader);
  messageContainer.appendChild(messageBody);
  chatMessages.appendChild(messageContainer);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Main function to send and receive message to NodeJS service 
async function sendChatMessage(question) {

  // Forming payload
  var payload = {
    q: question,
    u: userId,
    i: chatId
  }

  // Getting response stream instance
  const response = await fetch(chatBotServiceUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  // Start adding response message to DOM
  const messageContainer = document.createElement('div');
  messageContainer.classList.add('chat-message-container');
  const messageHeader = document.createElement('div');
  messageHeader.classList.add('chat-message-header');
  messageHeader.textContent = 'Bot: ';
  const messageBody = document.createElement('div');
  messageBody.classList.add('chat-message-body');
  messageContainer.appendChild(messageHeader);
  messageContainer.appendChild(messageBody);
  chatMessages.appendChild(messageContainer);

  // Getting the last message object from DOM
  let messageBodies = chatMessages.querySelectorAll('.chat-message-body');
  let lastMessageBody = messageBodies[messageBodies.length - 1];

  // Cycle to process the streaming response
  let total = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;

    const decodedValue = decoder.decode(chunk);

    switch (decodedValue) {
      case 'ERROR: RateLimitError':
        lastMessageBody.textContent = 'Rate Limit Exceeded';
        break;
      case 'ERROR: InternalServerError':
        lastMessageBody.textContent = 'Internal Server Error';
        break;
      case 'ERROR: BadRequestError':
        lastMessageBody.textContent = 'Bad Request Error';
        break;
      case 'ERROR: APIError':
        lastMessageBody.textContent = 'API Error';
        break;
      case 'ERROR: TokenLimitReached':
        lastMessageBody.textContent = 'Token Limit Reached';
        break;
      case 'ERROR: ConnectionAborted':
        lastMessageBody.textContent = 'Connection aborted';
        break;
      default:
        lastMessageBody.innerHTML += decodedValue.replace('\n', '<br />');
    }

    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

// Adding intro message to chat
if (!introMessageSent) {
  addChatMessage('Bot', 'Hello! I\'m an automated AWS AI assistant. Please enter your question below.');
  introMessageSent = true;
}
