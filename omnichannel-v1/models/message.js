class message {
    constructor(TenantId, From, To, FromMe, Message, IsRead, TimeStamp) {
      this.TenantId = TenantId; // represents the id generated by the firestore
      this.From = From;
      this.To = To; 
      this.FromMe = FromMe; 
      this.Message = Message; 
      this.IsRead = IsRead; 
      this.TimeStamp = TimeStamp;
    }
  }
   
  module.exports = message;