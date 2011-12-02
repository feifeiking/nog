var Path = require('path');
var FS = require('fs');
var EventEmitter = require('events').EventEmitter;
var Queue = require('./queue');
module.exports = createDB;

function createDB(root) {

  root = Path.resolve(process.cwd(), root);
  
  // Make sure we have a directory to work with
  var stat;
  try {
    stat = FS.statSync(root);
  } catch (err) {
    // try to create it if it's not there
    if (err.code === "ENOENT") {
      FS.mkdirSync(root);
      stat = FS.statSync(root);
    } else {
      throw err;
    }
  } 
  if (!stat.isDirectory()) {
    throw new Error("Path " + root + " is not a directory.");
  }

  var locks = {};

  var db = new EventEmitter();

  db.get = function (path, callback) {
    var queue = locks[path];

    // If a read happens in locked state...
    if (queue) {
      var last = queue.last()
      // ...and last in queue is read batch, add to it
      if (last.read) {
//      console.log("Read on locked cell - batched");
        last.batch.push(callback);
        return;
      }
//      console.log("Read on locked cell");
      // ...else append a new read batch
      queue.push({read:true,path:path,batch:[callback]});
      return;
    };
    
//    console.log("Read on idle cell");
    // .. otherwise lock state, create a read batch, and process queue
    locks[path] = queue = new Queue();
    queue.push({read:true,path:path,batch:[callback]});
    processQueue(path);
  };
  
  db.put = function (path, data, callback) {
    var queue = locks[path];
    
    var write = {write:true,path:path,data:data,callback:callback};
    
    // If write happens in locked state...
    if (queue) {
//      console.log("Write on locked cell")
      queue.push(write); 
      return
    }
    
//    console.log("Write on idle cell")
    // otherwise lock state, create write transaction and process queue
    locks[path] = queue = new Queue();
    queue.push(write); 
    processQueue(path);

  };
  
  return db;

  /////////////////////////////////////////////

  function processQueue(path) {
    var queue = locks[path];
    var next = queue.first();

    // If queue is empty, put in idle state
    if (!next) {
//      console.log("Unlocking " + path);
      delete locks[path];
      db.emit("unlock", path);

      return;
    }

    // If next is read, kick off read
    if (next.read) {
//      console.log("Process read " + next.path);
      get(next.path);
      return
    }

    // If next is write, kick off write
    if (next.write) {
//      console.log("Process write " + next.path);
      put(next.path, next.data);
      return;
    }
    
    throw new Error("Invalid item");
  }
  
  function onReadComplete(path, err, data) {
//    console.log("Read finished " + path);
    var queue = locks[path];
    var read = queue.shift();
    var batch = read.batch;

    // process queue
    processQueue(path);

    // When read finishes, get batch from queue and process it.
    for (var i = 0, l = batch.length; i < l; i++) {
       batch[i](err, data); 
    }

  }
  
  function onWriteComplete(path, err) {
//    console.log("Write finished " + path);
    var queue = locks[path];
    var write = queue.shift();

    processQueue(path);

    write.callback(err);

    db.emit("change", path, write.data);
    
  }

  // Lists entries in a folder
  function list(path) {
    path = Path.resolve(root, path);
    FS.readdir(path, function (err, files) {
      if (err) return onReadComplete(path, err);
      var entries = [];
      files.forEach(function (file) {
        var i = file.length - 5;
        if (file.substr(i) === ".json") {
          entries.push(file.substr(0, i));
        }
      });
      onReadComplete(path, null, entries);
    });
  }

  
  // Load an entry
  function get(path) {
    var jsonPath = Path.resolve(root, path + ".json");
    FS.readFile(jsonPath, function (err, json) {
      if (err) {
        if (err.code === "ENOENT") {
          return list(path); 
        }
        return onReadComplete(path, err);
      }
      var data;
      try {
        data = JSON.parse(json);
      } catch (err) {
        return onReadComplete(path, new Error("Invalid JSON in " + jsonPath + "\n" + err.message));
      }
      var markdownPath = Path.resolve(root, path + ".markdown");
      FS.readFile(markdownPath, 'utf8', function (err, markdown) {
        if (err) {
          if (err.code !== "ENOENT") {
            return onReadComplete(path, err);
          }
        } else {
          data.markdown = markdown;
        }
        onReadComplete(path, null, data);
      });
    });
  }
  
  // Put an entry
  function put(path, data) {
    var json;
    if (data.hasOwnProperty("markdown")) {
      Object.defineProperty(data, "markdown", {enumerable: false});
      json = JSON.stringify(data);
      Object.defineProperty(data, "markdown", {enumerable: true});
    } else {
      json = JSON.stringify(data);
    }
    var jsonPath = Path.resolve(root, path + ".json");
    FS.writeFile(jsonPath, json, function (err) {
      if (err) return onWriteComplete(path, err);
      if (data.hasOwnProperty("markdown")) {
        var markdownPath = Path.resolve(root, path + ".markdown");
        FS.writeFile(markdownPath, data.markdown, function (err) {
          onWriteComplete(path, err);
        });
        return;
      }
      onWriteComplete(path);
    });
  }
  
  
}


