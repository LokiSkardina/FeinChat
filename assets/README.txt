FeinChat for Windows 11 x64

1. Extract the entire archive into a folder you can write to.
2. Run FeinChat.exe from the extracted folder. Do not run it inside the ZIP.
3. Open Settings, choose Add connection, and select a provider or Custom provider.
4. Enter your API key and the exact text model ID from your provider.
5. Save the connection, create a New chat, and send a message.

No installer, separate Node.js, or browser is required.
An API account/key and internet access are required to generate replies.

Your chats, connections, API keys, preferences, and application caches are kept
in the data folder beside FeinChat.exe. The folder is created on first launch.
FeinChat saves chat history locally and sends the saved conversation as context
when you continue a chat. Local history does not depend on the provider keeping
a copy. The provider's own retention policy still applies to requests it receives.

Enter sends a message; Shift+Enter adds a line break. Stop cancels the request
and keeps the received text. Chat settings lets you change the connection/model
and override temperature or the output token limit. Blank values inherit the
connection settings or the API default.

Close FeinChat before moving or copying its folder. Move the entire folder,
including data, to keep your chats. To update, copy your existing data folder
beside the new FeinChat.exe and keep the old folder until you verify the update.

This clean distribution contains no personal chats or API keys. When sharing
FeinChat, send the clean archive; do not include your own data folder.
Keys are stored locally without encryption. Anyone with access to data can
read the keys and conversations. Do not share that folder with other people.

FeinChat keeps its own working data in this folder. Windows and other software
may create their own system records outside it.
