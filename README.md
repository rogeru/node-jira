# node-jira
Automatically create posts in a conversations with P1 issues from Jira


## Requirements ##
* [node 4.x](http://nodejs.org/download/)
* [circuit module](https://circuitsandbox.net/sdk/)

## Getting Started ##

```bash
    git clone https://github.com/yourcircuit/node-jira.git
    cd node-jira
    cp config.json.template config.json
```

Edit config.json
* Edit Circuit configuration in config.json.
    You can request a circuit account at the [Circuit Developer Community Portal](https://www.yourcircuit.com/web/developers).
* Edit Jira configuration in config.json
 
 Run the sample application with 
 
```bash
    npm install
    wget https://circuitsandbox.net/circuit.tgz
    npm install circuit.tgz
    node server.js | bunyan
```

Run with forever in background 
```bash
    forever start -l forever.log -o out.log -e err.log server.js
    tail -f out.log | bunyan
```


 If you do not have wget installed you can use curl to download circuit.tgz
```bash
curl "https://circuitsandbox.net/circuit.tgz" -o "circuit.tgz"
``` 
