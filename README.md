# kartozoa
Simple Kartotherian Tile Server Remix

This projectly is basically a merge of two different repositories - [kartotherian/kartotherian](http://github.com/kartotherian/kartotherian) & [kartotherian/kartotherian-server](http://github.com/kartotherian/kartotherian-server) - with various modifications to the file structure & a simplified API focusing on serving tiles.

# Usage
For everything but the API (setting up the database, configuration, sources) you can refer to all the original Kartotherian documentation @ [kartotherian/kartotherian](http://github.com/kartotherian/kartotherian) & [kartotherian/kartotherian-core](http://github.com/kartotherian/kartotherian-core).

Once you have everything prepared, you can install & start the service with the usual suspects: `npm install` & `npm start`. Navigate to `http://localhost:{port}` & you can check out the API which is practically the same as Kartotherian's but is missing some features. Navigate to `http://localhost:{port}/preview` & you get the same slippy map that Kartotherian serves as root. `http://localhost:{port}/{source}/{zoom}/{x}/{y}[@{scale}x].{format}` will get you tiles, just as in Kartotherian. 
