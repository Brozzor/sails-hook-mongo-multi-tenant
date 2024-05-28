const {getNamespace} = require("cls-hooked");
const MONGO_OPERAND = {'!=' : '$ne' , '>' : '$gt' , '<' : '$lt' , '<=' : '$lte' , '>=' : '$gte'}
const ObjectId = require('mongodb').ObjectId;

class MongoOperation extends Promise{

  cbk;
  cond;
  data;
  session;
  db;
  collection;
  modelDefinition
  currentUser;
  beforeCreate;
  beforeUpdate;
  stack;

  constructor(cbk , modelDefinition , collectionName , cond , data ) {
    super(cbk);
    this.stack = new Error().stack;
    this.cbk = cbk;
    this.cond = cond;
    let isCreate = !cond;
    this.currentUser = getNamespace('request-session').get("user");
    this.beforeCreate = modelDefinition.beforeCreate || ((d , cbk) => {cbk()})
    this.beforeUpdate = modelDefinition.beforeUpdate || ((d , cbk) => {cbk()})

    if (modelDefinition.isMultiTenant === false) {
      this.db = sails.tenant_db_con.default;
    } else {
      let user = getNamespace('request-session').get('user');
      const dbSession = getNamespace('request-session').get('session');
      this.session = dbSession ? {session: dbSession} : undefined

      if (!user){
        this.throwError('Cannot execute query on multitenant db without context user')
      }
      this.db = sails.tenant_db_con[user.tenant];
    }
    if (cond){
      this.cond = conditionConverter(cond , modelDefinition)
    }

    if (data){
      this.data = {}
      for (let k in modelDefinition.attributes){
        if (typeof data[k] != 'undefined' && data[k] !== null && modelDefinition.attributes[k].model){
          this.data[k] = new ObjectId(data[k]);
        }
        else if (isCreate && typeof data[k] == 'undefined' && typeof modelDefinition.attributes[k].defaultsTo != 'undefined') {
          this.data[k] = modelDefinition.attributes[k].defaultsTo;
        }else if(typeof data[k] != 'undefined') {
          if (data[k] === null){
            this.data[k] = null;
            continue;
          }
          switch (modelDefinition.attributes[k].type) {
            case 'number' :
              this.data[k] = Number(data[k]);
              break;
            case 'boolean':
              this.data[k] = !!data[k];
              break;
            case 'string':
              this.data[k] = String(data[k]);
              break;
            default :
              this.data[k] = data[k];
              break;
          }
        }
      }

    }

    this.collection = this.db.collection(collectionName);
    this.modelDefinition = modelDefinition;
  }

  exec(cbk){
    this.then((r) => {cbk(null , r)} , (e) => {cbk(e)})
  }

  throwError(err){
    sails.log.error(new Error(err))
    throw this.stack
  }

}

class DestroyOperation extends MongoOperation{

  constructor(cbk , modelDefinition , collection, cond , db ) {
    super(cbk , modelDefinition, collection , cond , null , db);
  }

  fetch(){
    return this;
  }

  then(onfulfilled, onrejected) {
    return this.collection.find(this.cond , this.session).toArray().then((result) => {
      this.collection.deleteMany(this.cond , this.session ).then(() => {
        result = convertIds(result);
        onfulfilled(result);
      }).catch(onrejected)
    }).catch(onrejected)
  }

}

class DestroyOneOperation extends MongoOperation{

  failIfNull = false;

  constructor(cbk , modelDefinition,collection, cond , db ) {
    super(cbk ,modelDefinition, collection , cond , null , db);
  }

  orFail(){
    this.failIfNull = true;
    return this;
  }


  then(onfulfilled, onrejected) {
    this.collection.findOneAndDelete(this.cond , this.session).then((r) => {
      if (this.failIfNull && !r.value){
        this.throwError("No result found with given criteria");
      }
      r = convertIds(r.value);
      onfulfilled(r);
    }).catch(onrejected);
  }

}

class CreateOperation extends MongoOperation{

  constructor(cbk , modelDefinition , collection , data  ) {
    super(cbk , modelDefinition,collection , null , data );
    this.data.createdAt = Date.now();
    this.data.updatedAt = Date.now();

  }

  fetch(){
    return this;
  }

  then(onfulfilled, onrejected) {
    return new Promise((a , r) => {
      let ns =  getNamespace('request-session');
      ns.run(() => {
        ns.set("user" , this.currentUser);
        this.beforeCreate(this.data , () => {
          let query = this.collection.insertOne(this.data , this.session)
            return query.then((r) => {
              this.collection.findOne({_id : r.insertedId} , this.session).then((res) => {
                res = convertIds(res)
                onfulfilled(res)
              })
            }).catch(onrejected)

        })
      });
    })
  }
}

class FindOperation extends MongoOperation{

  findOne = false
  failIfNull = false;

  constructor(cbk , modelDefinition , collection , cond , findOne ) {
    super(cbk , modelDefinition,collection , cond  );
    this.findOne = findOne;
  }

  sortOpts;
  limitOpts;
  populated = []

  sort(opts){
    let sort = opts;
    if (typeof sort == 'string'){
      sort = {}
      let params = opts.split(' ')
      sort[params[0]] = params[1] == 'ASC' ? 1 : -1;
    }
    this.sortOpts = sort;
    return this;
  }

  populate(field){
    this.populated.push(field);
    return this;
  }

  limit(opts){
    this.limitOpts = opts;
    return this;
  }

  orFail(){
    this.failIfNull = true;
    return this;
  }

  then(onfulfilled, onrejected) {

    let query = [];
    if (this.cond){
      query.push({$match : this.cond});
    }
    for (let p of this.populated){
      query.push(
        {
          '$lookup': {
            'from': this.modelDefinition.attributes[p].model,
            'localField': p,
            'foreignField': '_id',
            'as': p
          }
        },
        {
          '$unwind' : {
            path: "$"+p,
            'preserveNullAndEmptyArrays': true
          }
        },
      )
    }
    query = this.collection.aggregate(query ,this.session );
    if (this.sortOpts){
      query = query.sort(this.sortOpts);
    }
    if (this.limitOpts){
      query = query.limit(this.limitOpts);
    }

    return query.toArray().then((result) => {
      result = convertIds(result)
      if (this.findOne && this.failIfNull && result.length == 0){
        this.throwError("No result found with given criteria");
      }
      if (this.findOne && result.length > 1){
        this.throwError("Find one operation found more than 1 result")
      }
      onfulfilled(this.findOne ? result[0] : result)
    }).catch(onrejected)
  }
}

class FindOneOperation extends MongoOperation{

  populated = []

  populate(field){
    this.populated.push(field);
    return this;
  }

  then(onfulfilled, onrejected) {
    let query = [{$match : this.cond}];
    for (let p of this.populated){
      query.push( {
        '$lookup': {
          'from': this.modelDefinition.attributes[p].model,
          'localField': p,
          'foreignField': '_id',
          'as': p
        }
      })
    }
    query = this.collection.aggregate(query , this.session);
    return query.toArray().then((result) => {
      result = convertIds(result)
      onfulfilled(result[0])
    }).catch(onrejected)
  }

}

class UpdateOperation extends MongoOperation{

  constructor(cbk , modelDefinition , collection , cond , data  ) {
    super(cbk , modelDefinition,collection , cond , data );

    this.data.updatedAt = Date.now();
  }

  fetch(){
    return this;
  }
  then(onfulfilled, onrejected) {
    return new Promise((a , r) => {
      let query = this.collection.updateMany(this.cond, {$set: this.data} , this.session)
      let fetchQuery = this.collection.find(this.cond, this.session);
      return query.then(() => {
        fetchQuery.toArray().then((result) => {
          result = convertIds(result)
          onfulfilled(result);
        }).catch(onrejected)
      }).catch(onrejected)
    });
  }
}

class UpdateOneOperation extends MongoOperation{

  failIfNull = false;

  constructor(cbk , modelDefinition , collection , cond , data  ) {
    super(cbk , modelDefinition,collection , cond , data );
    this.data.updatedAt = Date.now();
  }

  orFail(){
    this.failIfNull = true;
    return this;
  }

  fetch(){
    return this;
  }

  then(onfulfilled, onrejected) {
    return new Promise((a , r) => {
      let ns = getNamespace('request-session');
      ns.run(() => {
        ns.set("user", this.currentUser);
        this.beforeUpdate(this.data, () => {
          let opts = {
            returnDocument: 'after'
          }
          if (this.session) opts.session = this.session.session
          let query = this.collection.findOneAndUpdate(this.cond, {$set: this.data} ,  opts)
          return query.then((res) => {
            if ( this.failIfNull && !res.value){
              this.throwError("No result found with given criteria");
            }
            res = convertIds(res.value)
            onfulfilled(res);
          }).catch(onrejected);
        })
      });
    });
  }
}

class CountOperation extends MongoOperation{

  then(onfulfilled, onrejected) {
    let query = this.collection.countDocuments(this.cond , this.session )
    return query.then((res) => {
      onfulfilled(res);
    }).catch(onrejected)
  }
}


function convertIds(obj){

  if (Array.isArray(obj)){
    for (let o of obj){
      convertIds(o)
    }
  }else if(typeof obj == 'object'){

    for (let k in obj){
      if (k === '_id'){
        obj['id'] = obj['_id'].toString()
        delete obj['_id'];
      }if (obj[k] && obj[k].constructor.name.toLowerCase() === 'objectid'){
        obj[k] = obj[k].toString()
      }
      else if (typeof obj[k] == 'object'){
        convertIds(obj[k])
      }
    }
  }
  return obj;

}

function conditionConverter(cond , modelDefinition) {

  let result = {}
  if (typeof cond == 'string'){
    result = {_id : new ObjectId(cond)};
  }else if (typeof cond == 'object') {
    for (let k in cond) {
      // Convert id to _id
      let key = k == 'id' ? '_id' : k;
      let value = cond[k];
      let isModelId = (modelDefinition.attributes[k] && modelDefinition.attributes[k].model) || k == 'id'

      if (value) {
        if (Array.isArray(value)) {
          if (isModelId) {
            value = value.map((v) => {
              return new ObjectId(v)
            })
          }
          value = {'$in': value}
        } else if (typeof value == 'object' && value.constructor.name !== 'ObjectId') {
          let op = Object.keys(value)[0]
          let val = Object.values(value)[0]
          if (isModelId) {

            val = val.map((v) => {
              return new ObjectId(v)
            })
          }
          if (Array.isArray(val)) {
            if (op == '!=') {
              value = {'$nin': val}
            }
          } else {
            if (isModelId) {
              val = new ObjectId(val)
            }
            value[MONGO_OPERAND[op]] = val;
            delete value[op];
          }
        } else if ((isModelId || key === '_id' && typeof value == 'string') && ObjectId.isValid(value)) {
           value = new ObjectId(value)
        }
      }

      result[key] = value;
    }
  }
  return result;
}


module.exports.MongoOperation = MongoOperation
module.exports.FindOperation = FindOperation
module.exports.FindOneOperation = FindOneOperation
module.exports.UpdateOperation = UpdateOperation
module.exports.UpdateOneOperation = UpdateOneOperation
module.exports.DestroyOperation = DestroyOperation
module.exports.DestroyOneOperation = DestroyOneOperation
module.exports.CreateOperation = CreateOperation
module.exports.CountOperation = CountOperation
