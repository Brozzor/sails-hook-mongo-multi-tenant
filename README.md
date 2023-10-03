![Alt text](image.png)
# Sails.js Multi-Tenant Hook for MongoDB
This is a Sails.js hook that provides multi-tenant functionality to your application. It allows you to serve multiple tenants (organizations, clients, etc.) from a single instance of your application.

## Installation

To install the hook, run the following command:

```js

npm install sails-hook-mongo-multitenant

```

In your models you need to add the following attribute for each model that you want to be multi-tenant:

```js
// Tenant.js
module.exports = {
    attributes: {
        name: {
            type: 'string',
            required: true
        }
    },
    isMultiTenant : false // add this attribute to your model
}  

```

Create a new policy for context (adapt for your code) :

```js
/**
 * contextTenant
 *
 * @description :: Policy to check if user is a global admin
 * @help        :: See http://sailsjs.org/#!/documentation/concepts/Policies
 */
const {getNamespace} = require("cls-hooked");
const MongoClient = require('mongodb').MongoClient;
const TenantService = require("../services/TenantService");
module.exports = async function (req, res, next) {
    let tenant;
    if (!req.headers.origin && req.headers.authorization){
        tenant = await Tenant.findOne({id: req.headers.authorization.split(" ")[1].split('.')[0]}).orFail();
    }else if (!req.headers.origin || (req.headers.origin.split('://').length < 2)) {
        return res.sendStatus(400); 
    }
    let ns = getNamespace('request-session');
    ns.run(async () => {
        if (!tenant) tenant = await Tenant.findOne({url : req.headers.origin.split('://')[1]}).orFail();
        if (!tenant || !tenant.isEnabled) return res.sendStatus(400);
        if (!sails.tenant_db_con[tenant.id]){
            const db = await MongoClient.connect('mongodb://127.0.0.1:27017/')
            sails.tenant_db_con[tenant.id] = db.db('tenant_' + tenant.id);
            console.log("Connected to TENANT DATABASE " + tenant.id + ' ('+tenant.url+')')
        }
        ns.set("user", {tenant : tenant.id, _tenant : tenant });
        let emitter = await TenantService.createDbConnection(tenant.id);
        res.on("finish", function () {
            emitter.emit("end");
        });

        next()
    })

};
```

## Credits

This hook was originally created by [Abdellatif El Maknati](https://www.linkedin.com/in/abdellatif-el-maknati-46b51659/)
